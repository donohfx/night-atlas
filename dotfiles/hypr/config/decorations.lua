-- Look and feel configuration

hl.config({
	general = {
		gaps_in = 3,
		gaps_out = 16,
		border_size = 1,
		extend_border_grab_area = 10,
		resize_on_border = true,
		col = {
			active_border = {
				colors = { CACHYLGREEN, CACHYDGREEN },
				angle = 45,
			},
			inactive_border = CACHYGRAY,
		},
	},
	group = {
		col = {
			border_active = CACHYLBLUE,
			border_inactive = CACHYGRAY,
			border_locked_active = CACHYDBLUE,
			border_locked_inactive = CACHYGRAY,
		},
		groupbar = {
			col = {
				active = CACHYLGREEN,
				inactive = CACHYGRAY,
				locked_active = CACHYDBLUE,
				locked_inactive = CACHYGRAY,
			},
		},
	},
	decoration = {
		dim_special = 0, -- no dimming behind special workspaces (Super+A / Super+S scratchpads)
		rounding = 3,
		active_opacity = 1.0, -- content apps opaque; terminals set their own background opacity
		inactive_opacity = 1.0, -- inactive windows are marked by dim_inactive alone
		fullscreen_opacity = 1,
		dim_inactive = false,
		dim_strength = 0.25,
		shadow = {
			range = 18, -- was 30: enough to lift floating windows without a haze around them
			render_power = 1, -- linear falloff: no dark line hugging the edge
			color = "rgba(00000044)", -- was 55: slightly lighter
			offset = { 0, 6 }, -- was 14: light from above, shorter drop; still clear of the gap under the bar
		},
		blur = {
			size = 5,
			passes = 4,
			special = false, -- don't blur the whole screen behind special workspaces
		},
	},
})
