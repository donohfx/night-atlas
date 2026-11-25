local mainMod = "SUPER"
local noctCall = "noctalia msg "
local launchPrefix = "uwsm app -- " -- if you are not using UWSM, make this empty (e.g. "")

-- Every bind carries a `description`: the Super+K keybind cheatsheet (Noctalia plugin) shows it.
local function d(text, opts)
	opts = opts or {}
	opts.description = text
	return opts
end

-- AZERTY fix: the number-row keys emit symbols (& é " ' ...) without Shift, so
-- binding to the digit characters fails. Bind by physical keycode instead.
-- Digit d -> evdev keycode: 1..9 => 10..18, 0 => 19
local function digitCode(n)
	return "code:" .. (n == 0 and 19 or (9 + n))
end

---------------------------
---- WINDOW MANAGEMENT ----
---------------------------

-- Window manipulation
hl.bind(mainMod .. " + Escape", hl.dsp.exec_cmd("hyprctl kill"), d("Kill a window (click to pick)"))
hl.bind(mainMod .. " + Q", hl.dsp.window.close(), d("Close window"))
hl.bind(mainMod .. " + ALT + Space", hl.dsp.window.float({ action = "toggle" }), d("Toggle floating"))
-- Snap: float the focused window into an exact tile position (quarters / halves),
-- leaving the rest of the screen empty, e.g. kitty-corner windows. Super+Alt+Space
-- (Toggle floating) puts it back into the tiling. Geometry: scripts/snap.sh.
local snapPath = os.getenv("HOME") .. "/.config/hypr/scripts/snap.sh"
local snap = "'" .. snapPath:gsub("'", "'\\''") .. "' "
hl.bind(mainMod .. " + ALT + U", hl.dsp.exec_cmd(snap .. "tl"), d("Snap window: top-left quarter"))
hl.bind(mainMod .. " + ALT + I", hl.dsp.exec_cmd(snap .. "tr"), d("Snap window: top-right quarter"))
hl.bind(mainMod .. " + ALT + J", hl.dsp.exec_cmd(snap .. "bl"), d("Snap window: bottom-left quarter"))
hl.bind(mainMod .. " + ALT + K", hl.dsp.exec_cmd(snap .. "br"), d("Snap window: bottom-right quarter"))
hl.bind(mainMod .. " + ALT + left", hl.dsp.exec_cmd(snap .. "left"), d("Snap window: left half"))
hl.bind(mainMod .. " + ALT + right", hl.dsp.exec_cmd(snap .. "right"), d("Snap window: right half"))
hl.bind(mainMod .. " + ALT + up", hl.dsp.exec_cmd(snap .. "top"), d("Snap window: top half"))
hl.bind(mainMod .. " + ALT + down", hl.dsp.exec_cmd(snap .. "bottom"), d("Snap window: bottom half"))
hl.bind(mainMod .. " + D", hl.dsp.window.fullscreen({ mode = 1 }), d("Maximize (keep bar and gaps)"))
hl.bind(mainMod .. " + F", hl.dsp.window.fullscreen(), d("Fullscreen"))
hl.bind(mainMod .. " + J", hl.dsp.layout("togglesplit"), d("Toggle split direction"))

-- Change focus
hl.bind(mainMod .. " + Left", hl.dsp.focus({ direction = "left" }), d("Focus window left"))
hl.bind(mainMod .. " + Right", hl.dsp.focus({ direction = "right" }), d("Focus window right"))
hl.bind(mainMod .. " + Up", hl.dsp.focus({ direction = "up" }), d("Focus window up"))
hl.bind(mainMod .. " + Down", hl.dsp.focus({ direction = "down" }), d("Focus window down"))
hl.bind("ALT + Tab", hl.dsp.window.cycle_next(), d("Cycle windows"))
hl.bind(mainMod .. " + Tab", hl.dsp.exec_cmd(noctCall .. "window-switcher"), d("Window switcher"))

-- Move active window around and between workspaces
hl.bind(mainMod .. " + SHIFT + Up", hl.dsp.window.move({ direction = "u" }), d("Move window up"))
hl.bind(mainMod .. " + SHIFT + Right", hl.dsp.window.move({ direction = "r" }), d("Move window right"))
hl.bind(mainMod .. " + SHIFT + Left", hl.dsp.window.move({ direction = "l" }), d("Move window left"))
hl.bind(mainMod .. " + SHIFT + Down", hl.dsp.window.move({ direction = "d" }), d("Move window down"))
-- (Super+Shift+digit monitor binds removed: single monitor. Super+Shift+4 is the region screenshot.)
hl.bind(mainMod .. " + SHIFT + mouse_up", hl.dsp.window.move({ monitor = "-1" }), d("Move window to previous monitor"))
hl.bind(mainMod .. " + SHIFT + mouse_down", hl.dsp.window.move({ monitor = "+1" }), d("Move window to next monitor"))
hl.bind(mainMod .. " + CONTROL + SHIFT + Right", hl.dsp.window.move({ workspace = "m+1" }), d("Move window to next workspace"))
hl.bind(mainMod .. " + CONTROL + SHIFT + Left", hl.dsp.window.move({ workspace = "m-1" }), d("Move window to previous workspace"))
hl.bind(mainMod .. " + CONTROL + SHIFT + mouse_up", hl.dsp.window.move({ workspace = "m-1" }), d("Move window to previous workspace"))
hl.bind(mainMod .. " + CONTROL + SHIFT + mouse_down", hl.dsp.window.move({ workspace = "m+1" }), d("Move window to next workspace"))
for i = 1, NUM_WPM do
	hl.bind(mainMod .. " + SHIFT + CONTROL + " .. digitCode(i % 10), hl.dsp.window.move({ workspace = "m~" .. i }), d("Move window to workspace " .. i .. " and follow"))
end
for i = 1, NUM_WPM do
	hl.bind(
		mainMod .. " + SHIFT + ALT + " .. digitCode(i % 10),
		hl.dsp.window.move({ workspace = "m~" .. i, follow = false }),
		d("Move window to workspace " .. i .. " (stay here)")
	)
end

-- Move & Resize with mouse
hl.bind(mainMod .. " + mouse:272", hl.dsp.window.drag(), d("Drag to move window"))
hl.bind(mainMod .. " + mouse:273", hl.dsp.window.resize(), d("Drag to resize window"))

-- Zoom
local function zoomfunction(value)
	local zoomvalue = hl.get_config("cursor:zoom_factor")
	if (zoomvalue + value) > 3.0 then
		hl.config({ cursor = { zoom_factor = 3.0 } })
	elseif (zoomvalue + value) < 1.0 then
		hl.config({ cursor = { zoom_factor = 1.0 } })
	else
		hl.config({ cursor = { zoom_factor = zoomvalue + value } })
	end
end
hl.bind(mainMod .. " + Minus", function()
	zoomfunction(-0.3)
end, d("Zoom out", { repeating = true }))
hl.bind(mainMod .. " + Plus", function()
	zoomfunction(0.3)
end, d("Zoom in", { repeating = true }))

--# Zoom with keypad
hl.bind(mainMod .. " + code:82", function()
	zoomfunction(-0.3)
end, d("Zoom out (keypad)", { repeating = true }))
hl.bind(mainMod .. " + code:86", function()
	zoomfunction(0.3)
end, d("Zoom in (keypad)", { repeating = true }))

------------------
---- LAUNCHER ----
------------------

hl.bind(mainMod .. " + Return", hl.dsp.exec_cmd(launchPrefix .. TERMINAL), d("Terminal"))
hl.bind(mainMod .. " + E", hl.dsp.exec_cmd(launchPrefix .. FILE_MANAGER), d("File manager"))
hl.bind(mainMod .. " + T", hl.dsp.exec_cmd(launchPrefix .. EDITOR), d("Text editor"))
hl.bind("XF86Calculator", hl.dsp.exec_cmd(launchPrefix .. CALCULATOR), d("Calculator"))
hl.bind(mainMod .. " + W", hl.dsp.exec_cmd(launchPrefix .. BROWSER), d("Browser"))
hl.bind("CONTROL + SHIFT + Escape", hl.dsp.exec_cmd(launchPrefix .. TERMINAL .. " -e btop"), d("System monitor (btop)"))
hl.bind(mainMod .. " + Z", hl.dsp.exec_cmd(noctCall .. "settings-toggle"), d("Noctalia settings"))
hl.bind(mainMod .. " + X", hl.dsp.exec_cmd(noctCall .. "panel-toggle control-center"), d("Control center (and notifications)"))
hl.bind(mainMod .. " + Space", hl.dsp.exec_cmd(noctCall .. "panel-toggle launcher"), d("App launcher"))
hl.bind(mainMod .. " + period", hl.dsp.exec_cmd(noctCall .. "panel-toggle launcher /emo"), d("Emoji picker"))
hl.bind(mainMod .. " + L", hl.dsp.exec_cmd(noctCall .. "session lock"), d("Lock screen"))
hl.bind(mainMod .. " + ALT + C", hl.dsp.exec_cmd(noctCall .. "panel-toggle session"), d("Session menu (log out, reboot...)"))

---------------------------
---- HARDWARE CONTROLS ----
---------------------------

-- Audio
hl.bind("XF86AudioRaiseVolume", hl.dsp.exec_cmd(noctCall .. "volume-up"), d("Volume up", { locked = true, repeating = true }))
hl.bind("XF86AudioLowerVolume", hl.dsp.exec_cmd(noctCall .. "volume-down"), d("Volume down", { locked = true, repeating = true }))
hl.bind("XF86AudioMute", hl.dsp.exec_cmd(noctCall .. "volume-mute"), d("Mute", { locked = true }))
hl.bind("XF86AudioMicMute", hl.dsp.exec_cmd(noctCall .. "mic-mute"), d("Mute microphone", { locked = true }))

-- Media
hl.bind("XF86AudioPlay", hl.dsp.exec_cmd(noctCall .. "media toggle"), d("Play / pause", { locked = true }))
hl.bind("XF86AudioPause", hl.dsp.exec_cmd(noctCall .. "media toggle"), d("Play / pause", { locked = true }))
hl.bind("XF86AudioNext", hl.dsp.exec_cmd(noctCall .. "media next"), d("Next track", { locked = true }))
hl.bind("XF86AudioPrev", hl.dsp.exec_cmd(noctCall .. "media previous"), d("Previous track", { locked = true }))

-- Brightness
hl.bind("XF86MonBrightnessUp", hl.dsp.exec_cmd(noctCall .. "brightness-up"), d("Brightness up", { locked = true, repeating = true }))
hl.bind("XF86MonBrightnessDown", hl.dsp.exec_cmd(noctCall .. "brightness-down"), d("Brightness down", { locked = true, repeating = true }))

-------------------
---- UTILITIES ----
-------------------

-- Screen Capture
hl.bind(mainMod .. " + P", hl.dsp.exec_cmd("hyprpicker -a -n"), d("Color picker (copies hex)"))
hl.bind("SUPER + SHIFT + code:13", hl.dsp.exec_cmd(noctCall .. "screenshot-region"), d("Screenshot region"))
hl.bind(mainMod .. " + Print", hl.dsp.exec_cmd(noctCall .. "screenshot-fullscreen"), d("Screenshot full screen"))

-- Theming and Wallpaper
hl.bind(mainMod .. " + SHIFT + W", hl.dsp.exec_cmd(noctCall .. "panel-toggle wallpaper"), d("Wallpaper picker"))

-- Clipboard
hl.bind(mainMod .. " + V", hl.dsp.exec_cmd(noctCall .. "panel-toggle clipboard"), d("Clipboard history"))

-------------------------------
---- WORKSPACES & MONITORS ----
-------------------------------

-- Super+digit = focus workspace N (was: focus monitor 1-3; single monitor now)
for i = 1, NUM_WPM do
	hl.bind(mainMod .. " + " .. digitCode(i % 10), hl.dsp.focus({ workspace = i }), d("Go to workspace " .. i))
end

-- Focus on workspace number
-- Absolute
for i = 1, NUM_WPM do
	hl.bind(mainMod .. " + ALT + " .. digitCode(i % 10), hl.dsp.focus({ workspace = i }), d("Go to workspace " .. i))
end
-- Relative
for i = 1, NUM_WPM do
	hl.bind(mainMod .. " + CONTROL + " .. digitCode(i % 10), hl.dsp.focus({ workspace = "m~" .. i }), d("Go to workspace " .. i .. " on this monitor"))
end

-- Move to adjacent workspaces and next empty on a given monitor
hl.bind(mainMod .. " + CONTROL + Right", hl.dsp.focus({ workspace = "m+1" }), d("Next workspace"))
hl.bind(mainMod .. " + CONTROL + Left", hl.dsp.focus({ workspace = "m-1" }), d("Previous workspace"))
hl.bind(mainMod .. " + CONTROL + Down", hl.dsp.focus({ workspace = "emptym" }), d("First empty workspace"))

-- Scroll through existing workspaces & monitors
hl.bind(mainMod .. " + mouse_down", hl.dsp.focus({ workspace = "m-1" }), d("Previous workspace"))
hl.bind(mainMod .. " + mouse_up", hl.dsp.focus({ workspace = "m+1" }), d("Next workspace"))
hl.bind(mainMod .. " + CONTROL + mouse_up", hl.dsp.focus({ workspace = "m-1" }), d("Previous workspace"))
hl.bind(mainMod .. " + CONTROL + mouse_down", hl.dsp.focus({ workspace = "m+1" }), d("Next workspace"))

-- Special workspace (scratchpad)
hl.bind(mainMod .. " + SHIFT + S", hl.dsp.window.move({ workspace = "special" }), d("Send window to scratchpad"))
hl.bind(mainMod .. " + S", hl.dsp.workspace.toggle_special(), d("Toggle scratchpad"))
