--!nonstrict
-- Workspace ovals bar widget: dots, with the active workspace as a longer
-- accent-coloured oval. Occupied workspaces are brighter than empty ones.
-- Click a dot to switch to that workspace.
--
-- Animation: every slot has a weight w (0 = dot, 1 = active oval). On a switch
-- the new active slot's weight eases to 1 and the old one's to 0, so the oval
-- shrinks out of the old slot while it grows (and brightens) into the new one.
-- Frames come from barWidget.setNeedsFrameTick/onFrameTick when the host
-- supports it, otherwise from a fast update interval while animating.

local DOT = 8 -- dot diameter (px)
local ACTIVE = 24 -- active oval length (px)
local SPEED = 16 -- easing rate per second (higher = snappier); ~200 ms to settle
local IDLE_MS = 1000 -- update interval when not animating (fallback path only)
local FRAME_MS = 16

local st = noctalia.state.get("wso.state") or { workspaces = {} }
local weight = {} -- weight[id] = 0..1
local animating = false
local hasFrameTick = type(barWidget.setNeedsFrameTick) == "function"
local lastMs = 0

local function switchTo(ws)
  local expr = 'hl.dsp.focus({ workspace = "' .. tostring(ws.id) .. '" })'
  noctalia.runAsync({ "hyprctl", "dispatch", expr }, function(_r) end, 3000)
end

local function setAnimating(on)
  if on == animating then return end
  animating = on
  lastMs = noctalia.nowMs()
  if hasFrameTick then
    barWidget.setNeedsFrameTick(on)
  else
    noctalia.setUpdateInterval(on and FRAME_MS or IDLE_MS)
  end
end

local function render()
  local vertical = barWidget.isVertical()
  local dots = {}
  for _, ws in ipairs(st.workspaces or {}) do
    local w = weight[ws.id] or 0
    local long = DOT + (ACTIVE - DOT) * w
    local fill
    if w > 0.04 then
      -- Fade the accent in with the stretch.
      fill = string.format("primary/%.2f", 0.35 + 0.65 * w)
    else
      fill = (ws.windows or 0) > 0 and "on_surface/0.75" or "on_surface/0.28"
    end
    table.insert(dots, ui.row({
      align = "center",
      padding = 3,
      onClick = function() switchTo(ws) end,
    }, {
      ui.box({
        width = vertical and DOT or long,
        height = vertical and long or DOT,
        radius = DOT / 2,
        fill = fill,
      }),
    }))
  end
  local container = vertical and ui.column or ui.row
  barWidget.render(container({ gap = 2, align = "center" }, dots))

  local name = nil
  for _, ws in ipairs(st.workspaces or {}) do
    if ws.id == st.active then name = ws.name end
  end
  barWidget.setTooltip(name and ("Workspace " .. name) or "")
end

-- Ease every weight toward its target; returns true while still moving.
local function step(dtMs)
  local k = math.min(1, SPEED * (dtMs / 1000))
  local moving = false
  for _, ws in ipairs(st.workspaces or {}) do
    local target = ws.id == st.active and 1 or 0
    local w = weight[ws.id] or 0
    w += (target - w) * k
    if math.abs(target - w) < 0.01 then w = target else moving = true end
    weight[ws.id] = w
  end
  return moving
end

local function tick(dtMs)
  local moving = step(dtMs)
  render()
  if not moving then setAnimating(false) end
end

function onFrameTick(deltaMs)
  if animating then tick(tonumber(deltaMs) or FRAME_MS) end
end

function update()
  if animating and not hasFrameTick then
    local now = noctalia.nowMs()
    local dt = now - lastMs
    lastMs = now
    tick(dt > 0 and dt or FRAME_MS)
  else
    render()
  end
end

noctalia.state.watch("wso.state", function(value)
  if type(value) ~= "table" then return end
  local first = next(weight) == nil
  st = value
  if first then
    -- First snapshot: no animation, just place the oval.
    for _, ws in ipairs(st.workspaces or {}) do weight[ws.id] = ws.id == st.active and 1 or 0 end
    render()
  else
    setAnimating(true)
    render()
  end
end)

for _, ws in ipairs(st.workspaces or {}) do weight[ws.id] = ws.id == st.active and 1 or 0 end
if not hasFrameTick then noctalia.setUpdateInterval(IDLE_MS) end
render()
