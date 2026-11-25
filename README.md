# Night Atlas

An interactive maritime atlas of Nova Scotia, Halifax coast, and Halifax Harbour. Explore coastal relief, lighthouse signals, and ship snapshots. **Not for navigation.** Lighthouse beams are approximate.

## Web app

Open the controls to change view, choose Chart, Night, or Auto, toggle layers, or start a tour. Hover or tap a feature to see its details. View, appearance, and layer preferences persist in your browser.

```sh
python -m http.server 8000 --directory web
```

Open http://localhost:8000/?static. The static preview can display the chart and fetch weather. Use Netlify for the ships and buoy endpoints.

## Netlify with ships

1. Fork or clone this repository and connect it to a Netlify project. The included `netlify.toml` configures the publish directory (`web/`) and functions directory (`netlify/functions/`).
2. Confirm that your AIS Stream account permits serving public snapshots. Create a key through the [AIS Stream account page](https://aisstream.io/account).
3. Set `AISSTREAM_API_KEY` in the Netlify environment with Functions scope. See [.env.example](.env.example) for refresh settings. Keep the key in the server environment. The map works with an unset key and reports that ships are unconfigured.
4. Deploy. Open the map and check `/api/ships` after a refresh cycle. Inspect Functions logs and the Netlify usage dashboard. Each deployment environment that shares the key with another site or the desktop feed can add connections against the same provider account limit.

The ship function opens one short WebSocket subscription for the region, keeps a last-known snapshot in Netlify Blobs, and uses a distributed lease to avoid simultaneous collectors on the same site. Netlify’s CDN absorbs repeated requests and can return a cached response during refresh. A short sample has partial coverage. Some regional vessels may appear on later refreshes, and the app fades old reports.

### Usage and cost

Netlify has two kinds of Free plan; check which one your team is on. The figures below are untested estimates. A collection runs for about 18 seconds, and ships refresh every **5 minutes** by default (`AIS_SNAPSHOT_TTL_SECONDS=300`). A first visit downloads about 4.6 MB.

- **Legacy Free** (accounts created before 4 September 2025): 100 GB bandwidth (about 20,000 first visits) and 125,000 function calls per site each month. With someone watching nonstop, ship collection uses about 41 function-hours a month at 5 minutes, or about 90 at 2 minutes. [Legacy plans](https://docs.netlify.com/manage/accounts-and-billing/billing/billing-for-legacy-plans/legacy-pricing-plans/)
- **Credit-based Free:** 300 credits a month with a hard limit. Constant viewing at 5 minutes is about 400 compute credits (over the allowance), one active hour a day about 17, and a 600-second TTL about 210. Requests and bandwidth also use credits. [Credit plans](https://docs.netlify.com/manage/accounts-and-billing/billing/billing-for-credit-based-plans/credit-based-pricing-plans/)

Watch your usage page and raise the TTL if traffic is sustained.

The public Open-Meteo endpoint is for noncommercial use under its hosted API terms. See [Credits](CREDITS.md) for data and software licences.

## Desktop

See the [desktop install guide](dotfiles/README.md) for packages, backup and installation, Noctalia plugins, and the separate desktop AIS key at `~/.config/night-atlas/aisstream.key`. The embedded desktop map retains its local Python server and Noctalia integration. The browser version is adapted from the same map, with independent runtime entry points.

**Licences differ by file.** MIT covers the code. Map data keeps its own terms, and the lighthouse data is for **non-commercial use only**: see [DATA-LICENSE.md](DATA-LICENSE.md).

[Build scripts and data sources](tools/README.md) · [Credits](CREDITS.md) · [MIT licence](LICENSE)
