# Night Atlas desktop setup

Use a Hyprland release with its Lua configuration API (0.57 or newer) and
Noctalia 5.4 or newer with plugin API 43 support. These files use the standard
`~/.config` location. They are intended for a CachyOS or Arch Linux user session
with Wayland and a working GPU driver.

## Packages

Install the packages you need as appropriate for your installation:

```sh
sudo pacman -S hyprland noctalia uwsm xdg-desktop-portal-hyprland \
  gtk4 gtk4-layer-shell webkitgtk-6.0 python python-gobject \
  kitty fastfetch mpv btop jq socat wireplumber power-profiles-daemon \
  grim slurp wl-clipboard hyprpicker
```

The launch shortcuts use Firefox, Dolphin, GNOME Text Editor, and GNOME
Calculator. Install `firefox dolphin gnome-text-editor gnome-calculator` or
set your preferred commands in `hypr/config/variables.lua` before installation.
Iosevka Aile, Monaspace Neon, and a Nerd Font for Fastfetch symbols are optional
fonts available separately. Install [uosc](https://github.com/tomasklaen/uosc)
if you want its mpv controls. Install uosc after applying these dotfiles so
its scripts and assets land in the new mpv directory. The supplied theme uses
stock uosc's line timeline. The custom uosc patch and icon font referenced by
the original local setup were absent from the staged source.

## Install with a backup

**Log out of Hyprland and stop Noctalia before applying the files.** Use a
separate session or TTY. Review and independently back up your configuration
first. The installer moves existing application directories and Noctalia's
saved settings to unique backup directories, then
installs the Night Atlas copies. Any plug-ins, application scripts, or other
files you previously kept in those directories will be in the backup. Move
individual files back after checking them for conflicts. To roll back, stop
the affected applications, move the installed directories and settings aside,
and move their originals back from the printed backup paths.

```sh
./tools/install-dotfiles.sh
./tools/install-dotfiles.sh --apply
```

For a manual install, back up the six app directories, then copy the contents
of `dotfiles/` into the corresponding directories under `~/.config/`.
Keep `settings.toml.example` outside Noctalia's config directory. After
backing up Noctalia's saved settings, copy the example to
`~/.local/state/noctalia/settings.toml` (or the equivalent override location).
Replace `@NIGHT_ATLAS_WALLPAPER@` with the absolute path to the installed
`night-atlas-still.jpg` in both entries. The installer performs this
substitution automatically. Leave `~` in Noctalia's template and plugin source
paths, which support home-relative paths. Noctalia's saved settings take
precedence over `config.toml`. [Noctalia configuration guide](https://docs.noctalia.dev/noctalia/configuration/)

Start Hyprland through UWSM. For a session without UWSM, set
`launchPrefix = ""` in `hypr/config/binds.lua`. The generic monitor settings
use the preferred hardware mode and automatic scale. Edit
`hypr/config/monitors.lua` and `hypr/config/variables.lua` for fixed
monitor settings. By default Night Atlas uses GDK's first monitor. Set
`NIGHT_ATLAS_OUTPUT` in the graphical session environment to choose a
connector such as `DP-1`. The workspace shortcuts use physical digit-row
keycodes.

In Noctalia **Settings → Plugins**, make sure the local source points to
`~/.config/noctalia/plugins`. The example settings enable
`local/night-atlas-ais`, `local/app-glyphs`, `local/power-button`,
`local/quick-settings`, and `local/workspace-ovals`. They can also be
enabled from Settings if you preserve existing state. Select **NightAtlas**
under the custom palette source. This activates the map layer.
[Noctalia plugin guide](https://docs.noctalia.dev/noctalia/plugins/)

## Desktop ships

The GTK/WebKit map uses the system Python and its PyGObject package. The
separate AIS feed needs a virtual environment with `websockets`:

```sh
python -m venv ~/.config/night-atlas/.venv
~/.config/night-atlas/.venv/bin/python -m pip install 'websockets>=13,<17'
```

Save your AIS Stream key as the only line in
`~/.config/night-atlas/aisstream.key` and set its permissions to `0600`.
Use a local editor so the key stays out of shell history. Restart Noctalia
after adding it. The desktop plugin connects from Python and serves its
background map over a local loopback HTTP server. The public web version
uses the site's Netlify snapshot endpoint. The chart is for display only and
lighthouse beams are approximate.

## Add a tray glyph

The app-glyphs plugin starts with an empty app registry. Add an entry to
`APPS` in `~/.config/noctalia/plugins/app-glyphs/bar.luau`, using the
app's actual StatusNotifierItem ID, Hyprland window class, and launch command:

```lua
music = { trayId = "example-music", glyph = "music", name = "Music",
          class = "example-music", cmd = { "example-music" } },
```

Add `glyph_music` to the bar position you want and configure that widget
instance. The optional `hidden` list prevents a duplicate tray icon.

```toml
[widget.glyph_music]
type = "local/app-glyphs:bar"
app = "music"

[widget.tray]
hidden = [ "example-music" ]
```

Use the bundled `tray-ids.sh` to list the IDs of currently running tray apps.
