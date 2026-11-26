# Night Atlas · Harbour Watch

Two things live in this repository:

- **Night Atlas** is a desktop theme for Hyprland and Noctalia: a live chart of Nova Scotia as the desktop background, with matching colours across the apps. See [Desktop](#desktop).
- **[Harbour Watch](https://harbour.briandonohue.ca)** is the same chart hosted on the web, for anyone to browse: coastal relief, lighthouse signals and live ships.

**Not for navigation.** Lighthouse beams are approximate.

## Web app

Open the controls to change view, switch between chart and night with the moon/sun button (it follows Halifax daylight until you change it), toggle layers, or start a tour. Hover or tap a feature to see its details. View, appearance, and layer preferences persist in your browser.

```sh
python -m http.server 8000 --directory web
```

Open http://localhost:8000/?static. The static preview can display the chart and fetch weather. Run the server (below) for ships and buoys.

## Fly.io with live ships

One small always-on machine serves the map, polls [Open Waters AIS](https://openwaters.io/ais/) for ships, keeps a single AIS Stream connection open as a backup and proxies the buoys. Set `OPENWATERS_USER_AGENT` to identify your copy with a contact, as Open Waters asks, or `OPENWATERS=off` to use AIS Stream alone.

```sh
fly apps create your-app-name          # then set the same name as `app` in fly.toml
fly secrets set AISSTREAM_API_KEY=your-key -a your-app-name
fly deploy --ha=false                  # one machine: one AIS connection
```

Get a free key from the [AIS Stream account page](https://aisstream.io/account). Ships accumulate over the first few minutes after a restart. Check [Fly pricing](https://fly.io/pricing) for current machine and traffic costs. For a custom domain, run `fly certs add your.domain -a your-app-name` and add the DNS records it prints.

The page counts visits with [GoatCounter](https://www.goatcounter.com/) (no cookies). In `web/index.html`, remove that script or put your own site code in it.

To run the tiled chart locally, use Node 24 and ImageMagick:

```sh
npm ci
npm run build:tiles
PORT=8767 npm start
```

Open http://localhost:8767/. Supply `AISSTREAM_API_KEY` to enable live ships.
The build uses the checked-in chart inputs and writes six archives to `web/tiles/`.
For an external archive host, set `ATLAS_TILE_BASE_URL` to the root URL that
contains the six files. The host must support HTTP byte ranges without content
encoding, allow the web app's origin, and expose `ETag` and `Content-Range` to it.
Use a versioned archive URL when publishing a replacement set.

The public Open-Meteo endpoint is for noncommercial use under its hosted API terms. See [Credits](CREDITS.md) for data and software licences.

## Desktop

See the [desktop install guide](dotfiles/README.md) for packages, backup and installation, Noctalia plugins, and the separate desktop AIS key at `~/.config/night-atlas/aisstream.key`. The embedded desktop map retains its local Python server and Noctalia integration. The browser version is adapted from the same map, with independent runtime entry points.

Just want the live wallpaper on another Hyprland setup (such as Omarchy)? See [wallpaper/](wallpaper/README.md): no Noctalia needed.

**Licences differ by file.** MIT covers the code. Map data keeps its own terms, and the lighthouse data is for **non-commercial use only**: see [DATA-LICENSE.md](DATA-LICENSE.md).

[Build scripts and data sources](tools/README.md) · [Credits](CREDITS.md) · [MIT licence](LICENSE)
