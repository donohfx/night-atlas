#!/bin/sh
# snap.sh POSITION [class:NAME]: float a window (the focused one, or the first
# window of class NAME) and place it exactly where a tile would be, so it looks
# tiled but leaves the rest of the screen empty.
# POSITION: tl tr bl br (quarters) | left right top bottom (halves)
# Geometry matches dwindle tiles: gaps_out at the screen edges, 2*gaps_in
# between tiles, the border outside each window, and the bar's reserved space.
set -eu
pos=${1:?usage: snap.sh tl|tr|bl|br|left|right|top|bottom}
mon=$(hyprctl monitors -j | jq -c '.[] | select(.focused)')
case ${2:-} in
  class:*) win=$(hyprctl clients -j | jq -c --arg c "${2#class:}" '[.[] | select(.class == $c)][0] // {"address": null}') ;;
  *) win=$(hyprctl activewindow -j) ;;
esac
addr=$(echo "$win" | jq -r .address)
[ "$addr" != "null" ] || exit 0

scale=$(echo "$mon" | jq -r .scale)
read -r mx my mw mh rl rt rr rb <<EOT
$(echo "$mon" | jq -r --argjson s "$scale" '[.x, .y, (.width/$s|floor), (.height/$s|floor), .reserved[0], .reserved[1], .reserved[2], .reserved[3]] | @tsv')
EOT
go=$(hyprctl getoption general:gaps_out -j | jq -r '.css | split(" ")[0] // empty'); go=${go:-8}
gi=$(hyprctl getoption general:gaps_in -j | jq -r '.css | split(" ")[0] // empty'); gi=${gi:-3}
bs=$(hyprctl getoption general:border_size -j | jq -r .int)

# Content rectangle of the whole usable area (inside outer gaps and borders).
x0=$((mx + rl + go + bs)); y0=$((my + rt + go + bs))
x1=$((mx + mw - rr - go - bs)); y1=$((my + mh - rb - go - bs))
gap=$((2 * gi + 2 * bs))                 # content-to-content gap between tiles
hw=$(((x1 - x0 - gap) / 2)); hh=$(((y1 - y0 - gap) / 2))
xr=$((x1 - hw)); yb=$((y1 - hh))         # right / bottom tile origins
fw=$((x1 - x0)); fh=$((y1 - y0))

case $pos in
  tl) x=$x0 y=$y0 w=$hw h=$hh ;;
  tr) x=$xr y=$y0 w=$hw h=$hh ;;
  bl) x=$x0 y=$yb w=$hw h=$hh ;;
  br) x=$xr y=$yb w=$hw h=$hh ;;
  left) x=$x0 y=$y0 w=$hw h=$fh ;;
  right) x=$xr y=$y0 w=$hw h=$fh ;;
  top) x=$x0 y=$y0 w=$fw h=$hh ;;
  bottom) x=$x0 y=$yb w=$fw h=$hh ;;
  *) echo "unknown position $pos" >&2; exit 1 ;;
esac

if [ "$(echo "$win" | jq -r .floating)" != "true" ]; then
  hyprctl dispatch "hl.dsp.window.float({ action = \"toggle\", window = \"address:$addr\" })" >/dev/null
fi
hyprctl dispatch "hl.dsp.window.resize({ x = $w, y = $h, exact = true, window = \"address:$addr\" })" >/dev/null
hyprctl dispatch "hl.dsp.window.move({ x = $x, y = $y, exact = true, window = \"address:$addr\" })" >/dev/null
