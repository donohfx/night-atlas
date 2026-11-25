--!nonstrict
-- Power button: the standard power icon, muted at rest; on hover it fades to
-- the theme's error (rose) colour and back on leave. Click toggles the
-- built-in session menu.

local SPEED = 12 -- easing rate per second (~250 ms to settle)
local FRAME_MS = 16
local IDLE_MS = 1000

local p = 0 -- 0 = rest, 1 = hovered
local target = 0
local animating = false
local lastMs = 0

local function rgb(hex)
  hex = (hex or "#000000"):gsub("#", "")
  return tonumber(hex:sub(1, 2), 16), tonumber(hex:sub(3, 4), 16), tonumber(hex:sub(5, 6), 16)
end

-- True colour blend between the two theme roles (read live, so it follows
-- theme changes), so brightness never dips mid-fade.
local function blend(t)
  local r0, g0, b0 = rgb(noctalia.getColor("on_surface_variant"))
  local r1, g1, b1 = rgb(noctalia.getColor("error"))
  local mix = function(a, b) return math.floor(a + (b - a) * t + 0.5) end
  return string.format("#%02x%02x%02x", mix(r0, r1), mix(g0, g1), mix(b0, b1))
end

local function render()
  local color = p < 0.01 and "on_surface_variant" or (p > 0.99 and "error" or blend(p))
  barWidget.render(ui.glyph({ name = "power", color = color }))
  barWidget.setTooltip("Power: lock, log out, suspend, reboot, shut down")
end

local function setAnimating(on)
  if on == animating then return end
  animating = on
  lastMs = noctalia.nowMs()
  noctalia.setUpdateInterval(on and FRAME_MS or IDLE_MS)
end

function update()
  if not animating then return end
  local now = noctalia.nowMs()
  local dt = math.max(1, now - lastMs)
  lastMs = now
  p += (target - p) * math.min(1, SPEED * dt / 1000)
  if math.abs(target - p) < 0.01 then
    p = target
    setAnimating(false)
  end
  render()
end

function onHover(entered)
  target = entered and 1 or 0
  setAnimating(true)
end

function onClick()
  noctalia.runAsync({ "noctalia", "msg", "panel-toggle", "session" }, function(_r) end, 3000)
end

noctalia.setUpdateInterval(IDLE_MS)
render()
