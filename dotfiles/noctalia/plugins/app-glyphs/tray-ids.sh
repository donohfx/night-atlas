#!/bin/sh
# Print the Id of every registered StatusNotifierItem (tray icon), one per line.
busctl --user get-property org.kde.StatusNotifierWatcher /StatusNotifierWatcher \
  org.kde.StatusNotifierWatcher RegisteredStatusNotifierItems 2>/dev/null \
  | grep -oE '"[^"]+"' | tr -d '"' | while read -r item; do
      bus=${item%%/*}; obj=/${item#*/}
      busctl --user get-property "$bus" "$obj" org.kde.StatusNotifierItem Id 2>/dev/null \
        | sed -n 's/^s "\(.*\)"$/\1/p'
    done
