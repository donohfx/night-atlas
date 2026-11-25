--!nonstrict
-- Night Atlas bar widget. Left click: menu (views, mode, layers). Right click: quick
-- chart/night toggle that lasts until the next sunrise or sunset (click again to undo).
local home = noctalia.getenv("HOME")
local runtime = noctalia.getenv("XDG_RUNTIME_DIR")
local SETTINGS = home .. "/.config/night-atlas/settings.json"
local serial = 0
barWidget.setGlyph("anchor")
barWidget.setColor("on_surface_variant")

local function showStatus(snapshot)
  local title = "Night Atlas · click for menu · right-click to flip chart/night"
  if snapshot then
    title = title .. "\n" .. (snapshot.status == "live" and "AIS live" or "AIS reconnecting")
      .. " · " .. snapshot.count .. " last-heard positions"
  end
  barWidget.setTooltip(title)
end

local function show(view)
  serial += 1
  noctalia.writeFile(runtime .. "/night-atlas-live-command.json",
    noctalia.json.encode({ id = tostring(noctalia.nowMs()) .. "-" .. serial, view = view }))
end

local function quickToggle()
  local ok, doc = pcall(noctalia.json.decode, noctalia.readFile(SETTINGS) or "")
  doc = (ok and type(doc) == "table") and doc or { mode = "auto" }
  local now = noctalia.nowMs() / 1000
  -- An override older than 12 h has certainly expired (the map ignores it), so treat it as absent.
  if type(doc.override) == "table" and now - (doc.override.at or 0) < 43200 then
    doc.override = nil
  else
    doc.override = { mode = "toggle", at = now }
  end
  noctalia.writeFile(SETTINGS, noctalia.json.encode(doc))
end

noctalia.state.watch("night-atlas.ais", showStatus)
showStatus(noctalia.state.get("night-atlas.ais"))

function onClick()
  noctalia.togglePanel("local/night-atlas-ais:menu")
end

function onRightClick()
  quickToggle()
end

function onIpc(event)
  if event == "nova-scotia" or event == "halifax" or event == "halifax-coast" then show(event) end
  if event == "menu" then onClick() end
  if event == "toggle" then quickToggle() end
end
