--!nonstrict
-- Workspace ovals service: snapshots Hyprland's workspaces and publishes
-- "wso.state" = { active = id, workspaces = { {id, name, windows}, ... } }.
-- Refreshes on every relevant Hyprland event (socket2 via socat) and every 30 s.

local SNAPSHOT = [[jq -cn --argjson ws "$(hyprctl -j workspaces)" --argjson a "$(hyprctl -j activeworkspace)" ]]
  .. [['{active: $a.id, workspaces: ([$ws[] | select(.id > 0) | {id, name, windows}] | sort_by(.id))}']]

local EVENTS = {
  workspace = true, workspacev2 = true,
  createworkspace = true, createworkspacev2 = true,
  destroyworkspace = true, destroyworkspacev2 = true,
  moveworkspace = true, moveworkspacev2 = true,
  renameworkspace = true, focusedmon = true, focusedmonv2 = true,
  openwindow = true, closewindow = true, movewindow = true, movewindowv2 = true,
}

local inFlight, again = false, false

local function refresh()
  if inFlight then again = true return end
  inFlight = true
  local started = noctalia.runAsync(SNAPSHOT, function(result)
    inFlight = false
    if result.exitCode == 0 then
      local ok, doc = pcall(noctalia.json.decode, result.stdout or "")
      if ok and type(doc) == "table" then noctalia.state.set("wso.state", doc) end
    end
    if again then again = false refresh() end
  end, 5000)
  if not started then inFlight = false end
end

local function shellQuote(s)
  return "'" .. string.gsub(s, "'", "'\\''") .. "'"
end

local function startStream()
  local runtime = noctalia.getenv("XDG_RUNTIME_DIR")
  local sig = noctalia.getenv("HYPRLAND_INSTANCE_SIGNATURE")
  if not (runtime and sig and noctalia.commandExists("socat")) then return end
  local sock = shellQuote(runtime .. "/hypr/" .. sig .. "/.socket2.sock")
  noctalia.runStream("while true; do socat -u UNIX-CONNECT:" .. sock .. " - 2>/dev/null; sleep 2; done", function(line)
    local event = string.match(line, "^([%w_]+)>>")
    if event and EVENTS[event] then refresh() end
  end)
end

noctalia.setUpdateInterval(30000)
function update() refresh() end

refresh()
startStream()
