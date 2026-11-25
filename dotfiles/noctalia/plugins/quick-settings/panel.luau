--!nonstrict
-- Quick settings panel: compact replacement for the control centre's Home page.
--   header  : time · date, settings, close
--   stats   : CPU %, CPU temp, GPU temp, RAM %, uptime (live while open)
--   pills   : Bluetooth, Night light, Do not disturb, power profile
--   sliders : output volume, mic (hidden when there is no input device)
--   media   : now playing with previous / play-pause / next
--   footer  : Wi-Fi toggle (kept out of the way) + links to the built-in
--             control centre's detailed tabs
-- Caffeine is not here: Noctalia exposes no way to read its state, and the bar
-- already has a caffeine toggle.

local DIR = noctalia.pluginDir()
local st = nil -- status.sh output
local busy = false

local function refresh()
  if busy then return end
  busy = true
  noctalia.runAsync({ "sh", DIR .. "/status.sh" }, function(result)
    busy = false
    local ok, doc = pcall(noctalia.json.decode, result.stdout or "")
    if ok and type(doc) == "table" then st = doc end
    render()
  end, 5000)
end

-- Run a command, then re-read state (short delay so the change has landed).
local function act(argv)
  noctalia.runAsync(argv, function(_r) refresh() end, 5000)
end

local function msg(...)
  local argv = { "noctalia", "msg" }
  for _, a in ipairs({ ... }) do table.insert(argv, a) end
  act(argv)
end

-- ── pieces ─────────────────────────────────────────────────────────────────

local function stat(glyph, text, warn)
  return ui.row({ gap = 4, align = "center" }, {
    ui.glyph({ name = glyph, size = 13, color = warn and "error" or "on_surface_variant" }),
    ui.label({ text = text, fontSize = 12, color = warn and "error" or "on_surface" }),
  })
end

local function fmtUptime(secs)
  secs = math.floor(tonumber(secs) or 0)
  local d, h, m = math.floor(secs / 86400), math.floor(secs % 86400 / 3600), math.floor(secs % 3600 / 60)
  if d > 0 then return `{d}d {h}h` end
  if h > 0 then return `{h}h {m}m` end
  return `{m}m`
end

local function statsRow()
  local s = noctalia.systemStats()
  local items = {}
  if s then
    table.insert(items, stat("cpu", `{math.floor(s.cpu.usagePercent + 0.5)}%`))
    if s.cpu.tempC then table.insert(items, stat("temperature", `{math.floor(s.cpu.tempC + 0.5)}°`, s.cpu.tempC >= 85)) end
    if s.gpu and s.gpu.tempC then table.insert(items, stat("device-desktop", `{math.floor(s.gpu.tempC + 0.5)}°`, s.gpu.tempC >= 85)) end
    table.insert(items, stat("device-sd-card", `{math.floor(s.ram.usagePercent + 0.5)}%`, s.ram.usagePercent >= 90))
  end
  if st then table.insert(items, stat("clock-up", fmtUptime(st.uptime))) end
  return ui.row({ gap = 14, align = "center", justify = "space_between", padding = 10, radius = 8, fill = "surface_container/0.5" }, items)
end

local function pill(glyph, label, on, onClick)
  return ui.row({
    gap = 8,
    align = "center",
    flexGrow = 1,
    paddingH = 12,
    paddingV = 9,
    radius = 8,
    fill = on and "primary" or "surface_container_high/0.7",
    onClick = onClick,
  }, {
    ui.glyph({ name = glyph, size = 15, color = on and "on_primary" or "on_surface" }),
    ui.label({ text = label, fontSize = 12, fontWeight = "medium", color = on and "on_primary" or "on_surface", maxLines = 1 }),
  })
end

local PROFILE_LABEL = { ["power-saver"] = "Power saver", balanced = "Balanced", performance = "Performance" }
local PROFILE_GLYPH = { ["power-saver"] = "leaf", balanced = "scale", performance = "rocket" }

local function pills()
  local nl = noctalia.nightlight.state()
  local bt = st and st.bluetooth == "on"
  local dnd = st and st.dnd == "on"
  local profile = st and st.profile or "balanced"
  return ui.column({ gap = 8 }, {
    ui.row({ gap = 8 }, {
      pill("bluetooth", "Bluetooth", bt, function() msg(bt and "bluetooth-disable" or "bluetooth-enable") end),
      pill("moon", "Night light", nl and nl.enabled, function() noctalia.nightlight.toggle() render() end),
    }),
    ui.row({ gap = 8 }, {
      pill("bell-off", "Do not disturb", dnd, function() msg("notification-dnd-toggle") end),
      pill(PROFILE_GLYPH[profile] or "scale", PROFILE_LABEL[profile] or profile, profile == "performance", function() msg("power-cycle") end),
    }),
  })
end

local function slider(glyph, mutedGlyph, value, muted, onSet, onMute)
  local pct = math.floor((value or 0) * 100 + 0.5)
  return ui.row({ gap = 10, align = "center" }, {
    ui.button({ glyph = muted and mutedGlyph or glyph, variant = "ghost", controlSize = "sm", onClick = onMute }),
    ui.slider({ min = 0, max = 100, step = 1, value = pct, flexGrow = 1, onChange = onSet }),
    ui.label({ text = muted and "muted" or `{pct}%`, fontSize = 12, color = "on_surface_variant", width = 44 }),
  })
end

local function sliders()
  local rows = {}
  if st and st.volume then
    table.insert(rows, slider("volume", "volume-off", st.volume, st.muted, function(v)
      act({ "wpctl", "set-volume", "@DEFAULT_AUDIO_SINK@", tostring((tonumber(v) or 0) / 100) })
    end, function() act({ "wpctl", "set-mute", "@DEFAULT_AUDIO_SINK@", "toggle" }) end))
  end
  if st and st.mic then
    table.insert(rows, slider("microphone", "microphone-off", st.mic, st.micMuted, function(v)
      act({ "wpctl", "set-volume", "@DEFAULT_AUDIO_SOURCE@", tostring((tonumber(v) or 0) / 100) })
    end, function() act({ "wpctl", "set-mute", "@DEFAULT_AUDIO_SOURCE@", "toggle" }) end))
  end
  return ui.column({ gap = 4 }, rows)
end

local function media()
  local p = noctalia.mediaPlayer()
  if not p or p.title == "" then return nil end
  local playing = p.status == "Playing"
  local artist = (p.artists and p.artists[1]) or p.identity
  return ui.row({ gap = 10, align = "center", padding = 10, radius = 8, fill = "surface_container/0.5" }, {
    ui.glyph({ name = "music", size = 18, color = "primary" }),
    ui.column({ gap = 1, flexGrow = 1 }, {
      ui.label({ text = p.title, fontSize = 12, fontWeight = "medium", maxLines = 1 }),
      ui.label({ text = artist, fontSize = 11, color = "on_surface_variant", maxLines = 1 }),
    }),
    ui.button({ glyph = "player-skip-back", variant = "ghost", controlSize = "sm", onClick = function() msg("media", "previous") end }),
    ui.button({ glyph = playing and "player-pause" or "player-play", variant = "ghost", controlSize = "sm", onClick = function() msg("media", "toggle") end }),
    ui.button({ glyph = "player-skip-forward", variant = "ghost", controlSize = "sm", onClick = function() msg("media", "next") end }),
  })
end

local function openTab(tab)
  panel.close()
  noctalia.runAsync({ "noctalia", "msg", "panel-open", "control-center", tab }, function(_r) end, 5000)
end

local function footer()
  local wifi = st and st.wifi == "on"
  local link = function(glyph, tab, tip)
    return ui.button({ glyph = glyph, variant = "ghost", controlSize = "sm", tooltip = tip, onClick = function() openTab(tab) end })
  end
  return ui.row({ gap = 2, align = "center" }, {
    ui.button({
      glyph = wifi and "wifi" or "wifi-off",
      text = wifi and "Wi-Fi on" or "Wi-Fi off",
      variant = "ghost",
      controlSize = "sm",
      onClick = function() msg(wifi and "wifi-disable" or "wifi-enable") end,
    }),
    ui.spacer({ flexGrow = 1 }),
    link("volume", "audio", "Audio devices"),
    link("network", "network", "Network"),
    link("bluetooth", "bluetooth", "Bluetooth devices"),
    link("calendar", "calendar", "Calendar"),
    link("bell", "notifications", "Notifications"),
  })
end

-- ── render ─────────────────────────────────────────────────────────────────

function render()
  local now = noctalia.formatTime("%H:%M · %a %d %b")
  local body = { statsRow(), pills(), sliders() }
  local m = media()
  if m then table.insert(body, m) end
  panel.render(ui.column({ flexGrow = 1, gap = 12 }, {
    ui.row({ gap = 8, align = "center" }, {
      ui.label({ text = now, fontSize = 15, fontWeight = "bold", flexGrow = 1 }),
      ui.button({ glyph = "settings", variant = "ghost", controlSize = "sm", tooltip = "Noctalia settings",
        onClick = function() panel.close() noctalia.openSettings() end }),
      ui.button({ glyph = "x", variant = "ghost", controlSize = "sm", onClick = function() panel.close() end }),
    }),
    ui.column({ flexGrow = 1, gap = 12 }, body),
    ui.separator({}),
    footer(),
  }))
end

function onOpen(_context)
  panel.setWantsSecondTicks(true)
  render()
  refresh()
end

function onClose()
  panel.setWantsSecondTicks(false)
end

-- Second ticks while open: live stats and media, status every 3 s.
local ticks = 0
function update()
  ticks += 1
  if ticks % 3 == 0 then refresh() else render() end
end

noctalia.nightlight.watch(function(_state) if st then render() end end)
