#!/usr/bin/env bash
set -euo pipefail

usage() {
    printf 'Usage: %s [--apply]\nWithout --apply, prints the proposed changes.\n' "${0##*/}"
}

case "${1:-}" in
    ''|--apply) ;;
    -h|--help) usage; exit 0 ;;
    *) usage >&2; exit 2 ;;
esac
if (( $# > 1 )); then usage >&2; exit 2; fi

# The desktop scripts resolve their Night Atlas support files under ~/.config.
config="$HOME/.config"
state="${NOCTALIA_STATE_HOME:-${XDG_STATE_HOME:-$HOME/.local/state}/noctalia}"
source_dir=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../dotfiles" && pwd)
apps=(hypr noctalia kitty fastfetch mpv btop)

printf 'Configuration directories to replace after backup:\n'
printf '  %s\n' "${apps[@]/#/$config/}"
printf 'Noctalia settings to replace after backup:\n  %s/settings.toml\n' "$state"
if [[ ${1:-} != --apply ]]; then exit 0; fi

umask 077
mkdir -p -- "$config" "$state"
config_backup=$(mktemp -d -- "$config/night-atlas-backup.XXXXXXXX")
state_backup=$(mktemp -d -- "$state/night-atlas-backup.XXXXXXXX")
printf 'Backups are kept at %s and %s\n' "$config_backup" "$state_backup"
work=$(mktemp -d -- "$config/.night-atlas-stage.XXXXXXXX")
state_work=$(mktemp -d -- "$state/.night-atlas-stage.XXXXXXXX")
trap 'rm -rf -- "$work" "$state_work"' EXIT

for app in "${apps[@]}"; do
    cp -a -- "$source_dir/$app" "$work/$app"
done
python - "$work/noctalia/settings.toml.example" "$config/noctalia" > "$state_work/settings.toml" <<'PY'
import json
from pathlib import Path
import sys
import tomllib

example = Path(sys.argv[1]).read_text()
wallpaper = Path(sys.argv[2]) / "wallpapers/night-atlas-still.jpg"
settings = example.replace('"@NIGHT_ATLAS_WALLPAPER@"', json.dumps(str(wallpaper), ensure_ascii=False))
tomllib.loads(settings)
print(settings, end="")
PY
rm -- "$work/noctalia/settings.toml.example"

replace() {
    local source=$1 target=$2 backup=$3
    if [[ -e $target || -L $target ]]; then
        mv -T -- "$target" "$backup"
    fi
    if ! mv -T --no-clobber -- "$source" "$target" || [[ -e $source || -L $source ]]; then
        if [[ -e $backup || -L $backup ]]; then
            mv -T --no-clobber -- "$backup" "$target"
        fi
        printf 'Could not install %s. Check the printed backup directories.\n' "$target" >&2
        return 1
    fi
}

for app in "${apps[@]}"; do
    replace "$work/$app" "$config/$app" "$config_backup/$app"
done
replace "$state_work/settings.toml" "$state/settings.toml" "$state_backup/settings.toml"
printf 'Night Atlas configuration installed.\n'
