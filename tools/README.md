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

`web/region/config.json` holds the chart data and camera bounds. The web camera constrains its rotated viewport to the configured camera box. Keep the NOAA
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

The regional grid is ETOPO1 from the ERDDAP dataset linked above (41° to 56°
north, 78° to 49° west for the current chart). Halifax uses the same ETOPO
2022 input as the Nova Scotia source. The
[Natural Earth Admin 1 archive](https://naturalearth.s3.amazonaws.com/10m_cultural/ne_10m_admin_1_states_provinces.zip)
supplies the provincial and US masks; OSM supplies their coastlines.

Build the regional aids with `tools/build-atlas-aids.py --bounds W S E N
--output web/region/aids.json --dropped LOG`, using the data bounds from the
config and either the current Coast Guard sections or saved section HTML. For this phase,
pass `--atlantic-bounds -69.95 42.35 -55.50 48.65` to retain the earlier
Atlantic volume coverage. Use the numbered Atlantic and Newfoundland HTML
sections and Arctic section `arc1345-en.php`.
Then run `python tools/build-atlas-regional-marks.py PATH_TO_SAVED_CHS_JSON --nl-admin PATH_TO_ADMIN_SHAPEFILE`.
This filters an existing export and retains the checked-in NS corrections.
New marks outside the previous coverage use the Natural Earth Admin 1 layer
to select the waters nearest Newfoundland and Labrador.
It reads local files only.

## St. Lawrence marks and river water

`tools/build-atlas-river.py HARVEST AIDS ADMIN_SHAPEFILE STAGE` writes
`web/region/river-STAGE.json` from a saved chart-mark export and a complete List
of Lights build (Atlantic and Inland Waters sections). Run the stages in the
order `gulf`, `lower`, `upper`; each one skips records held by earlier stages.
The web map loads a bundle when it is visible near symbol zoom.

The OSM split land polygons treat most inland water as land. After
`extract-atlas-coast.py`, `build-atlas-live.py` and `build-atlas-provinces.py`
(each replaces these files), run

```sh
python tools/cut-atlas-river-water.py web/region WATER.json [WATER.json ...] \
  --border BORDER.json
```

once. The water inputs are Overpass `out geom` results holding the relations and
closed ways listed in the script. The border input is the result of
`rel(61320);way(r)(43.9,-76.9,45.1,-74.3);out geom;`. It replaces the
generalised Ontario and US focus boundary upstream of Cornwall. Then rebuild the
regional beam reach table. Other side waters appear only in the close-zoom
OpenStreetMap water layer.

The same run writes `tools/river-water.json.gz`, a compact simplified copy of
the cut water and its banks (© OpenStreetMap contributors, ODbL). The relief
tile build paints it in the sea tone, because the relief grid shows inland water
as land. Depth contours are unchanged. The untiled `?static` preview uses the
unpainted relief image.

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

## Provincial lighthouse layer

Run `python tools/build-atlas-provincial-lights.py` to regenerate the regional
web inventory and the match reviews from the checked-in extracts. Each
`tools/provinces/*.config.json` supplies thresholds and reviewed overrides for
one province. Its companion `*.osm.json` and `*.ccg.json` record the OSM
lighthouse objects and candidate fixed aids, including the List of Lights
section for each record. `*.review.json` lists every OSM object, the match
method and distance, nearby candidates, and the marks associated with promotions.

To refresh the extracts, supply `--province` with `--osm-pbf` and
`--ccg-html` pointing at a dated provincial OSM extract and saved List of
Lights sections. Refreshing uses pyosmium, Beautiful Soup and lxml.
Update the source URL in the province config when changing the OSM snapshot.
A reviewed override can map an OSM object to a specified volume and light
number, keep it as a chart mark, or supply verified fields under `light`.
Record the reason and source in the override.

After changing the provincial inventory or regional shoreline, run
`CHROME=/path/to/chrome node tools/beam-reach.mjs --regional`, then repeat
with `--check` and run `npm run build:tiles`. This uses the regional shoreline
and leaves the original Nova Scotia and open-source reach tables intact.

## Web gazetteer

`python3 tools/import-gazetteer.py` refreshes the compact CGNDB snapshot in
`tools/gazetteer.json.gz`. It uses ZIPs cached in `.local/cgn/` and prints source
SHA-256 hashes and counts, including excluded source rows by term. The snapshot
holds 166,850 points from the 2026-11-25 extracts. It keeps provinces and drops
other CGNDB administrative areas and metropolitan community territories. Use
`--cache DIR` to build from a retained set of downloads. See
[DATA-LICENSE.md](../DATA-LICENSE.md) for source terms.

`node tools/build-tiles.mjs --job=gazetteer` builds `web/tiles/gazetteer.pmtiles`.
The full tile build runs the same job in a dedicated Node process. Fly builds
from the committed regional snapshot without downloading from NRCan.
