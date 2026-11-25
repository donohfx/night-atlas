# Live wallpaper without Noctalia

The chart under your windows on Hyprland (for example Omarchy). Drag and zoom it wherever the desktop shows.
It pauses when windows cover it.

**Status: tested on CachyOS with Hyprland (map, ships connecting, views, night mode). Untested on Omarchy.** Please open an issue with what worked or broke.

## Install (Arch-based)

    sudo pacman -S --needed git gtk4 gtk4-layer-shell webkitgtk-6.0 python python-gobject python-websockets
    git clone https://github.com/donohfx/night-atlas ~/.local/share/night-atlas
    ~/.local/share/night-atlas/wallpaper/harbour-wallpaper start

Keep the cloned folder where it is; the script runs the map from inside it.

## Ships (optional)

Create a free key at [aisstream.io](https://aisstream.io/account), then:

    mkdir -p -m 700 ~/.config/night-atlas
    nano ~/.config/night-atlas/aisstream.key      # paste the key, one line
    chmod 600 ~/.config/night-atlas/aisstream.key
    ~/.local/share/night-atlas/wallpaper/harbour-wallpaper restart

## Commands

| Command | Does |
|---|---|
| `start`, `stop`, `restart`, `status` | Run or stop the wallpaper |
| `view nova-scotia` / `halifax-coast` / `halifax` | Jump to a saved view |
| `mode chart` / `night` / `auto` | Day or night (auto follows Halifax sunset) |
| `check`, `logs` | Troubleshooting |

For a keybind or a second monitor: `NIGHT_ATLAS_OUTPUT=DP-1 harbour-wallpaper restart` picks the screen.

## Start at login

Add to your Hyprland autostart file (Omarchy: `~/.config/hypr/autostart.conf`):

    exec-once = ~/.local/share/night-atlas/wallpaper/harbour-wallpaper start

On a Lua config, run the same command from your `hyprland.start` hook.

It sits above ordinary wallpaper programs, so you can leave yours running. To remove it: `stop`, delete the
autostart line and the cloned folder.

Not for navigation. Lighthouse data is for non-commercial use: see [DATA-LICENSE.md](../DATA-LICENSE.md).
