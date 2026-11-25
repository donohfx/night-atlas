# Rebuild chart data

Run from the repository root. Use a scratch directory such as `.local/data`
for upstream files and intermediate results. The shipped tiles and datasets
are ready to use without regenerating them.

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
