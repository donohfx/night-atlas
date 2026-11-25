-- CachyOS Hyprland Configuration

require("config.animations")
require("config.autostart")
require("config.colors")
require("config.decorations")
require("config.variables")
require("config.environment")
require("config.inputs")
require("config.binds")
require("config.misc")
require("config.monitors")
require("config.windowrules")
require("config.workspaces")



-- For Noctalia Color templates. noctalia.lua now comes from our user template
-- (~/.config/noctalia/templates/hyprland.lua); the built-in one is disabled, and its
-- undo hook deletes these lines, so restore them if they ever go missing.
require("noctalia").apply_theme()
