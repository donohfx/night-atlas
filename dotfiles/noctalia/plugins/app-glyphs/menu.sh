#!/bin/sh
# menu.sh TRAY_ID            -> print that tray item's menu as JSON:
#                               {bus, path, items: [{id, label, enabled, separator}]}
# menu.sh TRAY_ID click N    -> activate menu entry N (as if clicked in the tray)
want=$1
busctl --user get-property org.kde.StatusNotifierWatcher /StatusNotifierWatcher \
  org.kde.StatusNotifierWatcher RegisteredStatusNotifierItems 2>/dev/null \
  | grep -oE '"[^"]+"' | tr -d '"' | while read -r item; do
    bus=${item%%/*}; obj=/${item#*/}
    id=$(busctl --user get-property "$bus" "$obj" org.kde.StatusNotifierItem Id 2>/dev/null | sed -n 's/^s "\(.*\)"$/\1/p')
    [ "$id" = "$want" ] || continue
    menu=$(busctl --user get-property "$bus" "$obj" org.kde.StatusNotifierItem Menu 2>/dev/null | sed -n 's/^o "\(.*\)"$/\1/p')
    [ -n "$menu" ] || exit 3
    if [ "$2" = click ]; then
      busctl --user call "$bus" "$menu" com.canonical.dbusmenu Event isvu -- "$3" clicked i 0 0
      exit $?
    fi
    busctl --user call "$bus" "$menu" com.canonical.dbusmenu AboutToShow i 0 >/dev/null 2>&1
    busctl --user --json=short call "$bus" "$menu" com.canonical.dbusmenu GetLayout iias -- 0 1 0 \
      | jq -c --arg bus "$bus" --arg path "$menu" '{bus: $bus, path: $path, items: [.data[1][2][].data
          | {id: .[0], label: ((.[1].label.data // "") | gsub("_(?<c>.)"; "\(.c)")),
             enabled: (.[1].enabled.data != false),
             visible: (.[1].visible.data != false),
             separator: (.[1].type.data == "separator")}
          | select(.visible)]}'
    exit 0
  done
