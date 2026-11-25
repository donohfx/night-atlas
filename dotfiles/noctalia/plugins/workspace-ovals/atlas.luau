--!nonstrict
-- Fixed-width workspace labels over a single moving underline.
local SLOT = 35
local INK = 20
local state = noctalia.state.get("wso.state") or { workspaces = {} }
local position = nil
local target = nil
local lastTick = noctalia.nowMs()

local function switchTo(id)
  local command = 'hl.dsp.focus({ workspace = "' .. tostring(id) .. '" })'
  noctalia.runAsync({ "hyprctl", "dispatch", command }, function(_result) end, 3000)
end

local function render()
  local labels = {}
  for _, ws in ipairs(state.workspaces) do
    local color = "on_surface/0.42"
    if ws.id == state.active then
      color = "on_surface"
    elseif ws.windows > 0 then
      color = "on_surface_variant"
    end
    table.insert(labels, ui.column({
      width = SLOT, align = "center", onClick = function() switchTo(ws.id) end,
      tooltip = "Workspace " .. ws.name,
    }, {
      ui.label({ text = string.format("%02d", ws.id), color = color, fontFamily = "Monaspace Neon" }),
    }))
  end

  local ruler = position and {
    ui.box({ width = position, height = 2, fill = "transparent" }),
    ui.box({ width = INK, height = 2, fill = "primary" }),
  } or {}
  barWidget.render(ui.column({ gap = 3 }, {
    ui.row({}, labels),
    ui.row({ height = 2, justify = "start" }, ruler),
  }))
end

local function refresh(value)
  state = value
  target = nil
  for i, ws in ipairs(state.workspaces) do
    if ws.id == state.active then
      target = (i - 1) * SLOT + (SLOT - INK) / 2
      break
    end
  end
  position = position and target and math.min(position, #state.workspaces * SLOT - INK) or target
  lastTick = noctalia.nowMs()
  noctalia.setUpdateInterval(position ~= target and 16 or 1000)
  render()
end

function update()
  if not target or not position or position == target then return end
  local now = noctalia.nowMs()
  local deltaMs = math.max(1, now - lastTick)
  lastTick = now
  position += (target - position) * math.min(1, deltaMs * 0.016)
  if math.abs(target - position) < 0.4 then
    position = target
    noctalia.setUpdateInterval(1000)
  end
  render()
end

noctalia.state.watch("wso.state", refresh)
refresh(state)
