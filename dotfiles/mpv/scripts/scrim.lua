-- scrim.lua: soft dark gradients behind uosc's bottom controls and top bar, so the
-- accent-coloured UI stays readable over bright video. Fades in/out when the cursor
-- follows uosc's published visibility (user-data/uosc/scrim, from our uosc patch);
-- falls back to cursor zones if that property never appears.
-- Tunables: script-opts/scrim.conf
local opts = {
  bottom_height = 280,  -- gradient height in UI px (scaled by hidpi like uosc)
  top_height = 120,
  max_alpha = 0.8,      -- opacity at the screen edge (0..1)
  color = "000000",     -- RRGGBB
  zone_bottom = 210,    -- cursor distance from bottom that shows the scrim (UI px)
  zone_top = 160,
  fade_ms = 180,
  steps = 48,           -- gradient bands
}
require("mp.options").read_options(opts, "scrim")

local overlay = mp.create_osd_overlay("ass-events")
overlay.z = 1000 -- uosc draws at 2000
local W, H, scale = 0, 0, 1
local cur = { bottom = 0, top = 0 }   -- current visibility 0..1
local want = { bottom = 0, top = 0 }
local timer

local function bgr(hex) return hex:sub(5, 6) .. hex:sub(3, 4) .. hex:sub(1, 2) end
local function alpha_hex(a) return string.format("%02X", math.floor((1 - a) * 255 + 0.5)) end

-- one band per step; opacity eases out from 0 at the inner edge to max at the screen edge
local function gradient(y_edge, height, dir, vis, out)
  if vis <= 0.001 or height <= 0 then return end
  local band = height / opts.steps
  for i = 0, opts.steps - 1 do
    local t = (i + 0.5) / opts.steps     -- 0 = inner edge, 1 = screen edge
    local e = 1 - (1 - t) ^ 2.2          -- ease-out: dark quickly, long soft top edge
    local a = e * opts.max_alpha * vis
    -- integer band edges that tile exactly (overlaps would double the alpha = stripes)
    local y1, y2
    if dir > 0 then -- bottom: grows downward to the edge
      local top = y_edge - height
      y1, y2 = math.floor(top + i * band + 0.5), math.floor(top + (i + 1) * band + 0.5)
    else            -- top: grows upward to the edge
      local bot = y_edge + height
      y1, y2 = math.floor(bot - (i + 1) * band + 0.5), math.floor(bot - i * band + 0.5)
    end
    if y2 > y1 then
      out[#out + 1] = string.format(
        "{\\an7\\pos(0,0)\\bord0\\shad0\\blur0\\1c&H%s&\\1a&H%s&\\p1}m 0 %d l %d %d l %d %d l 0 %d{\\p0}",
        bgr(opts.color), alpha_hex(a), y1, W, y1, W, y2, y2)
    end
  end
end

local function render()
  if W == 0 then return end
  local out = {}
  gradient(H, opts.bottom_height * scale, 1, cur.bottom, out)
  gradient(0, opts.top_height * scale, -1, cur.top, out)
  overlay.res_x, overlay.res_y = W, H
  overlay.data = table.concat(out, "\n")
  overlay:update()
end

local step = 1000 / 60
local function tick()
  local moving = false
  for k in pairs(cur) do
    local d = want[k] - cur[k]
    if math.abs(d) > 0.001 then
      local inc = step / opts.fade_ms
      cur[k] = d > 0 and math.min(want[k], cur[k] + inc) or math.max(want[k], cur[k] - inc)
      moving = true
    end
  end
  render()
  if not moving and timer then timer:kill() end
end

local function set_want(b, t)
  if want.bottom == b and want.top == t then return end
  want.bottom, want.top = b, t
  if not timer then timer = mp.add_periodic_timer(step / 1000, tick) else timer:resume() end
end

mp.observe_property("osd-dimensions", "native", function(_, d)
  if d then W, H = d.w, d.h; render() end
end)
mp.observe_property("display-hidpi-scale", "number", function(_, s) scale = s or 1; render() end)
local uosc_driven = false
mp.observe_property("mouse-pos", "native", function(_, m)
  if uosc_driven then return end
  if not m or not m.hover or H == 0 then return set_want(0, 0) end
  set_want(m.y > H - opts.zone_bottom * scale and 1 or 0, m.y < opts.zone_top * scale and 1 or 0)
end)
-- debug/testing: `script-message-to scrim scrim-force 1|0`
mp.register_script_message("scrim-force", function(v) set_want(tonumber(v) or 1, tonumber(v) or 1) end)

-- Preferred: follow uosc's own visibility (published by our uosc patch as
-- user-data/uosc/scrim = "bottom,top"), so the scrim moves in lockstep with the controls,
-- including keyboard-triggered flashes. The mouse-zone logic above is only a fallback.
mp.observe_property("user-data/uosc/scrim", "string", function(_, v)
  if not v then return end
  local b, t = v:match("([%d.]+),([%d.]+)")
  if not b then return end
  uosc_driven = true
  if timer then timer:kill() end
  cur.bottom, cur.top = tonumber(b), tonumber(t)
  want.bottom, want.top = cur.bottom, cur.top
  render()
end)
