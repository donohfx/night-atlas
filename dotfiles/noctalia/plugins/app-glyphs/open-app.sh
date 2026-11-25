#!/bin/sh
# open-app.sh CLASS COMMAND...: focus the app's window if it has one, else run COMMAND
# (both apps are single-instance, so running it again just shows the window).
class=$1; shift
addr=$(hyprctl clients -j | jq -r --arg c "$class" 'map(select(.class == $c)) | .[0].address // empty')
if [ -n "$addr" ]; then
  hyprctl dispatch "hl.dsp.focus({ window = \"address:$addr\" })" >/dev/null
else
  uwsm app -- "$@" >/dev/null 2>&1 &
fi
