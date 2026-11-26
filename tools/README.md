# Rebuild chart data

Run from the repository root. Use a scratch directory such as `.local/data`
for upstream files and intermediate results. The checked-in datasets are ready to use as tile build inputs.

```sh
python -m venv .local/data-venv
.local/data-venv/bin/pip install numpy pillow contourpy pyshp shapely
mkdir -p .local/data
curl -fL 'https://oceanwatch.aoml.noaa.gov/erddap/griddap/etopo180.csv?altitude%5B(40):1:(50)%5D%5B(-71):1:(-55)%5D' -o .local/data/etopo-nova-scotia.csv
curl -fL 'https://oceanwatch.pifsc.noaa.gov/erddap/griddap/ETOPO_2022_v1_15s.csv?z%5B(44.30):1:(44.98)%5D%5B(295.9):1:(297.01)%5D' -o .local/data/etopo-halifax.csv
curl -fL 'https://osmdata.openstreetmap.de/download/land-polygons-split-4326.zip' -o .local/data/land.zip
unzip -p .local/data/land.zip '*/land_polygons.shp' > .local/data/land.shp
.local/data-venv/bin/python tools/extract-atlas-coast.py .local/data/land.shp .local/data/land.json.gz
.local/data-venv/bin/python tools/build-atlas-live.py \
  .local/data/etopo-nova-scotia.csv .local/data/land.json.gz web \
  --halifax-elevation .local/data/etopo-halifax.csv
python tools/build-atlas-seamarks.py web
```

The relief generator now creates regional contours directly from the ETOPO1
grid. Regenerated assets can differ from the shipped artwork and change as
OpenStreetMap contributors update features. See [data licences](../CREDITS.md).

## Lighthouse data

`web/chart-data.json` ships ready to use; the commands above do not rebuild it. `reconcile-atlas-signals.py` updates a chart file from saved Coast Guard List of Lights HTML sections plus an OpenStreetMap export, using `atlas-lighthouses.csv` and `atlas-light-overrides.json` (`--help` lists the arguments; needs `beautifulsoup4` and `lxml`). Terms: [DATA-LICENSE.md](../DATA-LICENSE.md).

### Beam shoreline reach

After rebuilding `web/land.json`, `web/chart-data.json` or `web/open-lights.json`, run
`CHROME=/path/to/chrome node tools/beam-reach.mjs` from the app directory. This
uses hardware Vulkan Chrome and the browser's existing 2D Canvas mask algorithm.
Run the same command with `--check` to compare the checked-in table against a
fresh computation for all coloured lights in both source datasets, including
every light that a sweep override could enable in combined mode. The check
reports absolute differences in metres and fails on any difference.

The table stores the mask step for each half-degree bearing, preserving the
exact original distance. Each dataset and the shoreline carry SHA-256 revision
checks. The map computes missing or stale rows using the Canvas mask. The
image build compresses the checked-in JSON with the other static files.


## Regional web chart inputs

`web/region/config.json` holds the chart data and camera bounds. The smaller
camera box leaves room for the rotated viewport corners. Keep the NOAA
download grid larger than the data box. To regenerate the checked-in regional
sources with the downloaded OSM, ETOPO and Natural Earth inputs:

```sh
data=.local/data
region=web/region
python tools/extract-atlas-coast.py "$data/land.shp" "$data/region-land.json.gz" --region "$region/config.json"
python tools/build-atlas-live.py "$data/etopo.csv" "$data/region-land.json.gz" "$region" \
  --halifax-elevation "$data/halifax.csv" --region "$region/config.json"
python tools/build-atlas-provinces.py "$data/admin/ne_10m_admin_1_states_provinces.shp" "$region"
rm "$region/relief-detail.jpg"
```

The regional grid is ETOPO1 from the ERDDAP dataset linked above (41° to 50°
north, 71° to 55° west for the current chart). Halifax uses the same ETOPO
2022 input as the Nova Scotia source. The
[Natural Earth Admin 1 archive](https://naturalearth.s3.amazonaws.com/10m_cultural/ne_10m_admin_1_states_provinces.zip)
supplies the provincial and US masks; OSM supplies their coastlines.

Build the regional aids with `tools/build-atlas-aids.py --bounds W S E N
--output web/region/aids.json --dropped LOG`, using the data bounds from the
config and either the current Coast Guard sections or saved section HTML.
Then run `python tools/build-atlas-regional-marks.py PATH_TO_SAVED_CHS_JSON`.
This filters an existing export and retains the checked-in NS corrections.
It reads local files only.

## Web tile build

Run `npm run build:tiles` from the repository root with Node 24 and ImageMagick 7.
The reference build used Node 24.22.3 and ImageMagick 7.1.2-36 with WebP support.
The script takes its regional chart inputs from `web/region/` and makes no network requests. It works
with the MapLibre worker pinned in `web/vendor/`. With a different worker version,
check the exported tiler adapter and compare against the corresponding GeoJSON
render before rebuilding. `MAGICK` can point to an alternate executable.

The web charts use Web Mercator pyramids for land, contours, relief, and close
depth shading. The province masks are also tiled. Fixed zoom-10 cells index beam reaches by
light and regional shoreline edges by track. The build validates the original
NS beam table against its source revisions before packaging. Regional sources
also support the static web preview. The desktop uses its original NS assets.
Generated archives are ignored by Git.

To compare captures, run `node tools/verify-shared-core.mjs tiles ASSET_DIR
OUTPUT_DIR WEB_FIXTURE_DIR` once per build, sequentially. The tool uses
hardware Vulkan Chrome only, with fixed time, weather and AIS fixtures.
Set `ATLAS_VERIFY_BROTLI=1` to use the precompressed production encoding for
static assets. `events.json` records completed response body bytes by stage.

Set `ATLAS_VERIFY_REGION=1` with the regional tile build to capture New Brunswick,
province focus and phone portrait and to check the rotated camera limits.
