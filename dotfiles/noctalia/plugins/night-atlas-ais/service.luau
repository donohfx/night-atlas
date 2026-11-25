--!nonstrict
local home = noctalia.getenv("HOME")
local function quote(value)
  return "'" .. value:gsub("'", "'\\''") .. "'"
end

noctalia.state.set("night-atlas.ais", { status = "waiting", count = 0 })
local active = noctalia.getSetting("theme.source") == "custom"
    and noctalia.getSetting("theme.custom_palette") == "NightAtlas"

if active then
  local directory = noctalia.pluginDir() .. "/"
  local python = home .. "/.config/night-atlas/.venv/bin/python"
  local command = "exec env GDK_BACKEND=wayland LD_PRELOAD=/usr/lib/libgtk4-layer-shell.so /usr/bin/python -B "
  noctalia.runStream(command .. quote(directory .. "live_desktop.py") .. " 2>&1", function(line)
    noctalia.log(line)
  end)
  local lastStatus = nil
  local started = noctalia.runStream("exec " .. quote(python) .. " -B " .. quote(directory .. "feed.py")
    .. " 2>/dev/null", function(line)
    local ok, snapshot = pcall(noctalia.json.decode, line)
    if ok and type(snapshot) == "table" and type(snapshot.points) == "number" then
      if snapshot.status ~= lastStatus then
        noctalia.log("AIS feed " .. snapshot.status .. " (" .. snapshot.points .. " cached positions)")
      end
      lastStatus = snapshot.status
      noctalia.state.set("night-atlas.ais", { status = snapshot.status, count = snapshot.points })
    end
  end)
  if not started then
    noctalia.state.set("night-atlas.ais", { status = "offline", count = 0 })
  end
end
