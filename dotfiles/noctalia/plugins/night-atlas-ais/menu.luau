--!nonstrict
-- Night Atlas anchor menu: view shortcuts, chart / night / auto mode, layer toggles.
-- Writes ~/.config/night-atlas/settings.json; live_desktop.py serves it to the map on /state.
-- The map decides night vs chart (sun times are computed there); "auto" = night from sunset.

local home = noctalia.getenv("HOME")
local runtime = noctalia.getenv("XDG_RUNTIME_DIR")
local SETTINGS = home .. "/.config/night-atlas/settings.json"
local PRESET = home .. "/.config/night-atlas/preset.json"  -- written by the map server: {"preset": name|null}
local clicked = nil                                       -- optimistic highlight until the map confirms
local serial = 0

local LAYERS = {
  { key = "ships", label = "Ships", glyph = "ship" },
  { key = "ghosts", label = "Ghost ships", glyph = "route" },
  { key = "buoys", label = "Weather buoys", glyph = "wind" },
  { key = "seamarks", label = "Chart marks", glyph = "lifebuoy" },
  { key = "lights", label = "Lights", glyph = "building-lighthouse" },
  { key = "weather", label = "Weather", glyph = "cloud" },
  { key = "fog", label = "Fog", glyph = "mist" },
  { key = "sky", label = "Cloud and moon", glyph = "moon" },
  { key = "rain", label = "Rain and snow", glyph = "cloud-rain" },
  { key = "spotlight", label = "Ship of the night", glyph = "ship" },
  { key = "labels", label = "Labels", glyph = "tag", default = false },
}
local MODES = {
  { key = "chart", label = "Chart", glyph = "map" },
  { key = "night", label = "Night", glyph = "moon" },
  { key = "auto", label = "Auto", glyph = "sunset-2" },
}

local function load()
  local ok, doc = pcall(noctalia.json.decode, noctalia.readFile(SETTINGS) or "")
  doc = (ok and type(doc) == "table") and doc or {}
  doc.mode = doc.mode or "auto"
  doc.layers = type(doc.layers) == "table" and doc.layers or {}
  for _, layer in ipairs(LAYERS) do
    if doc.layers[layer.key] == nil then
      if layer.default ~= nil then doc.layers[layer.key] = layer.default else doc.layers[layer.key] = not layer.soon end
    end
  end
  return doc
end

local function save(doc)
  noctalia.writeFile(SETTINGS, noctalia.json.encode(doc))
end

local function activePreset()
  local ok, doc = pcall(noctalia.json.decode, noctalia.readFile(PRESET) or "{}")   -- {"preset": name|null}
  return (ok and type(doc) == "table" and type(doc.preset) == "string") and doc.preset or nil
end

local function go(view)
  clicked = view
  serial += 1
  noctalia.writeFile(runtime .. "/night-atlas-live-command.json",
    noctalia.json.encode({ id = tostring(noctalia.nowMs()) .. "-menu-" .. serial, view = view }))
end

local function pill(glyph, label, on, onClick)
  return ui.row({
    gap = 8, align = "center", flexGrow = 1, paddingH = 12, paddingV = 9, radius = 8,
    fill = on and "primary" or "surface_container_high/0.7", onClick = onClick,
  }, {
    ui.glyph({ name = glyph, size = 15, color = on and "on_primary" or "on_surface" }),
    ui.label({ text = label, fontSize = 12, fontWeight = "medium", color = on and "on_primary" or "on_surface", maxLines = 1 }),
  })
end

local function heading(text)
  return ui.label({ text = text, fontSize = 11, fontWeight = "medium", color = "on_surface_variant" })
end

function render()
  local doc = load()
  local viewPreset = activePreset()
  if clicked and viewPreset ~= clicked then viewPreset = clicked end   -- show the click right away
  if clicked and activePreset() == clicked then clicked = nil end
  local modeRow = {}
  for _, mode in ipairs(MODES) do
    table.insert(modeRow, pill(mode.glyph, mode.label, doc.mode == mode.key, function()
      doc.mode = mode.key
      doc.override = nil                         -- an explicit mode choice clears any quick toggle
      save(doc)
      render()
    end))
  end
  local layerRows, current = {}, nil
  for i, layer in ipairs(LAYERS) do
    if i % 2 == 1 then current = {} table.insert(layerRows, current) end
    -- "soon" layers are placeholders (weather overlay, not built yet): shown, not clickable.
    table.insert(current, pill(layer.glyph, layer.label, (not layer.soon) and doc.layers[layer.key],
      (not layer.soon) and function()
        doc.layers[layer.key] = not doc.layers[layer.key]
        save(doc)
        render()
      end or nil))
  end
  local layerColumn = {}
  for _, row in ipairs(layerRows) do table.insert(layerColumn, ui.row({ gap = 8 }, row)) end

  local note = doc.mode == "auto" and "Auto: night from sunset to sunrise in Halifax." or ""
  if doc.override then note = "Quick toggle active until the next sunrise or sunset. Right-click the anchor to undo." end

  panel.render(ui.column({ flexGrow = 1, gap = 12 }, {
    ui.row({ gap = 8, align = "center" }, {
      ui.glyph({ name = "anchor", size = 16, color = "primary" }),
      ui.label({ text = "Night Atlas", fontSize = 15, fontWeight = "bold", flexGrow = 1 }),
      ui.button({ glyph = "x", variant = "ghost", controlSize = "sm", onClick = function() panel.close() end }),
    }),
    heading("View"),
    ui.row({ gap = 8 }, {
      pill("map-2", "Nova Scotia", viewPreset == "nova-scotia", function() go("nova-scotia") render() end),
      pill("ripple", "Coast", viewPreset == "halifax-coast", function() go("halifax-coast") render() end),
      pill("building-lighthouse", "Harbour", viewPreset == "halifax", function() go("halifax") render() end),
    }),
    heading("Mode"),
    ui.row({ gap = 8 }, modeRow),
    ui.label({ text = note, fontSize = 11, color = "on_surface_variant", maxLines = 2 }),
    heading("Layers"),
    ui.column({ gap = 8 }, layerColumn),
  }))
end

function onOpen(_context)
  clicked = nil
  panel.setWantsSecondTicks(true)        -- refresh the highlight while open (e.g. after dragging)
  render()
end

function onClose()
  panel.setWantsSecondTicks(false)
end

function update()
  render()
end
