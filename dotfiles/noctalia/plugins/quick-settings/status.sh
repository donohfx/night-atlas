#!/bin/sh
# Print the state the quick settings panel shows, as one JSON object.
num() { wpctl get-volume "$1" 2>/dev/null | sed -n 's/^Volume: \([0-9.]*\).*/\1/p'; }
muted() { wpctl get-volume "$1" 2>/dev/null | grep -q MUTED && echo true || echo false; }
v=$(num @DEFAULT_AUDIO_SINK@); [ -n "$v" ] || v=null
m=$(num @DEFAULT_AUDIO_SOURCE@); [ -n "$m" ] || m=null
up=$(cut -d' ' -f1 /proc/uptime)
printf '{"wifi":"%s","bluetooth":"%s","dnd":"%s","profile":"%s","volume":%s,"muted":%s,"mic":%s,"micMuted":%s,"uptime":%s}\n' \
  "$(noctalia msg wifi-status 2>/dev/null)" "$(noctalia msg bluetooth-status 2>/dev/null)" \
  "$(noctalia msg notification-dnd-status 2>/dev/null)" "$(powerprofilesctl get 2>/dev/null)" \
  "$v" "$(muted @DEFAULT_AUDIO_SINK@)" "$m" "$(muted @DEFAULT_AUDIO_SOURCE@)" "${up:-0}"
