--!nonstrict
-- App glyphs bar widget: one instance per app (setting "app", a key of APPS).
-- Drawn with barWidget.setGlyph, so it looks and spaces like built-in widgets.
-- Visible while the app's tray item is registered (checked every 3 s).
-- Click = focus the app's window or bring it up; right-click = the app's own
-- tray menu (menu.luau). Hide the app's tray Id in widget.tray.hidden.

local DIR = noctalia.pluginDir()

-- trayId: the StatusNotifierItem Id (see tray-ids.sh); class: Hyprland window class.
local APPS = {
  -- Register your apps here. See the desktop guide for an example.
}

local app = APPS[noctalia.getConfig("app") or ""]
local present = nil
local busy = false

local function render()
  if not app then
    barWidget.setVisible(false)
    return
  end
  barWidget.setVisible(present == true)
  barWidget.setGlyph(app.glyph)
  barWidget.setColor("on_primary_container") -- same as the bar's built-in widgets
  barWidget.setTooltip(app.name)
end

local function refresh()
  if busy or not app then return end
  busy = true
  local started = noctalia.runAsync({ "sh", DIR .. "/tray-ids.sh" }, function(result)
    busy = false
    local found = false
    for id in string.gmatch(result.stdout or "", "[^\n]+") do
      if id == app.trayId then found = true end
    end
    if found ~= present then
      present = found
      render()
    end
  end, 5000)
  if not started then busy = false end
end

function onClick()
  if not app then return end
  local argv = { "sh", DIR .. "/open-app.sh", app.class }
  for _, a in ipairs(app.cmd) do table.insert(argv, a) end
  noctalia.runAsync(argv, function(_r) end, 5000)
end

function onRightClick()
  if not app then return end
  noctalia.state.set("glyphs.menuFor", { trayId = app.trayId, name = app.name })
  noctalia.togglePanel("local/app-glyphs:menu")
end

-- IPC: noctalia msg plugin local/app-glyphs:bar all menu <trayId>  (opens that app's menu)
function onIpc(event, payload)
  -- Every instance receives "all"; only the one for this app answers.
  if event == "menu" and app and payload == app.trayId then onRightClick() end
end

function onConfigChanged()
  app = APPS[noctalia.getConfig("app") or ""]
  present = nil
  render()
  refresh()
end

noctalia.setUpdateInterval(3000)
function update() refresh() end

render()
refresh()
