"""Build the land-only focus masks from Natural Earth Admin 1 and OSM land."""
import argparse
from collections import defaultdict
import json
from pathlib import Path

import shapefile
from shapely import box, make_valid, points, covers, union_all
from shapely.geometry import shape, mapping
import numpy as np

parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument("admin", type=Path)
parser.add_argument("region", type=Path)
args = parser.parse_args()

def write(name, data):
    (args.region / name).write_text(json.dumps(data, separators=(",", ":"), ensure_ascii=False) + "\n")

west, south, east, north = json.loads((args.region / "config.json").read_text())["dataBounds"]
frame = box(west, south, east, north)
admin = defaultdict(list)
with shapefile.Reader(args.admin) as source:
    for record in source.iterShapeRecords(bbox=frame.bounds):
        country = record.record["adm0_a3"]
        if country in ("CAN", "USA"):
            key = record.record["iso_3166_2"] if country == "CAN" else "US"
            outline = make_valid(shape(record.shape.__geo_interface__)).intersection(frame)
            if not outline.is_empty:
                admin[key].append(outline)

outlines = {key: union_all(parts) for key, parts in sorted(admin.items())}
# In the focus calculation these samples approximate the visible footprint,
# including islands. Representatives cover shapes narrower than the grid.
xs, ys = np.meshgrid(np.arange(west, east, .13), np.arange(south, north, .10))
grid = points(xs.ravel(), ys.ravel())
samples = {}
for key, polygon in outlines.items():
    if key != "US":
        samples[key] = [[round(x, 3), round(y, 3)] for x, y in
                        [*(tuple(p.coords[0]) for p in grid[covers(polygon, grid)]),
                         tuple(polygon.representative_point().coords[0])]]
write("focus-points.json", samples)

land = union_all([shape(feature["geometry"]) for feature in
                  json.loads((args.region / "land.json").read_text())["features"]])
# Fill small differences in coastline resolution only where Natural Earth's
# polygons leave gaps. Keep the published shared borders untouched.
unassigned = land.difference(union_all(list(outlines.values())))
features = []
for key, polygon in outlines.items():
    fringe = unassigned.intersection(polygon.buffer(.035))
    unassigned = unassigned.difference(fringe)
    mask = land.intersection(polygon).union(fringe)
    parts = [mask] if mask.geom_type == "Polygon" else mask.geoms
    for part in parts:
        if part.geom_type == "Polygon" and not part.is_empty:
            features.append({"type": "Feature", "properties": {"region": key},
                             "geometry": mapping(part)})
write("provinces.json", {"type": "FeatureCollection", "features": features})
