--!nonstrict
-- App glyphs right-click menu: shows the tray menu of the app whose glyph was
-- right-clicked (bar.luau puts its tray Id and name in "glyphs.menuFor"), and
-- clicks the chosen entry through menu.sh.

local DIR = noctalia.pluginDir()
local target = nil -- { trayId, name }
local menu = nil -- { items = {...} } from menu.sh
local status = "Loading…"

function render()
  local rows = {}
  if menu and menu.items and #menu.items > 0 then
    for _, item in ipairs(menu.items) do
      if item.separator then
        table.insert(rows, ui.separator({}))
      else
        table.insert(rows, ui.row({
          padding = 8,
          radius = 6,
          fill = "surface_container/0.0",
          onClick = item.enabled and function()
            panel.close()
            noctalia.runAsync({ "sh", DIR .. "/menu.sh", target.trayId, "click", tostring(item.id) }, function(_r) end, 5000)
          end or nil,
        }, {
          ui.label({
            text = item.label,
            color = item.enabled and "on_surface" or "on_surface_variant",
            fontWeight = item.enabled and "medium" or "regular",
            flexGrow = 1,
          }),
        }))
      end
    end
  else
    table.insert(rows, ui.label({ text = status, color = "on_surface_variant" }))
  end
  panel.render(ui.column({ flexGrow = 1, gap = 8 }, {
    ui.label({ text = target and target.name or "App", fontSize = 14, fontWeight = "bold" }),
    ui.scroll({ flexGrow = 1, gap = 2 }, rows),
  }))
end

function onOpen(_context)
  target = noctalia.state.get("glyphs.menuFor")
  menu, status = nil, "Loading…"
  render()
  if not target then status = "No app selected" render() return end
  noctalia.runAsync({ "sh", DIR .. "/menu.sh", target.trayId }, function(result)
    local ok, doc = pcall(noctalia.json.decode, result.stdout or "")
    if ok and type(doc) == "table" then menu = doc else status = "This app has no tray menu right now" end
    render()
  end, 5000)
end
