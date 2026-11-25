"""Clip full-resolution OSM WGS84 land polygons to the Night Atlas viewport."""
import argparse
import gzip
import json
from pathlib import Path

import shapefile
from shapely import make_valid, union_all
from shapely.geometry import box, shape
from shapely.geometry.polygon import orient

parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument("land_shp", type=Path)
parser.add_argument("output", type=Path)
args = parser.parse_args()

bounds = (-69.14, 42.83, -55.50, 48.00)
clip = box(*bounds)
with args.land_shp.open("rb") as stream:
    reader = shapefile.Reader(shp=stream)
    pieces = []
    for record in reader.iterShapes(bbox=bounds):
        piece = make_valid(shape(record.__geo_interface__)).intersection(clip)
        if not piece.is_empty:
            pieces.append(piece)

# OSM's split dataset carries artificial tile edges. Dissolve them before
# stroking the shore so they don't show up as lines in the water or on land.
land = union_all(pieces).simplify(0.00007, preserve_topology=True)

def polygons(geometry):
    if geometry.geom_type == "Polygon":
        yield orient(geometry, sign=1)
    elif hasattr(geometry, "geoms"):
        for part in geometry.geoms:
            yield from polygons(part)

def coordinates(ring):
    return [[round(x, 6), round(y, 6)] for x, y in ring.coords]

result = [
    [coordinates(poly.exterior), *(coordinates(ring) for ring in poly.interiors)]
    for poly in polygons(land)
]
with gzip.open(args.output, "wt") as stream:
    json.dump(result, stream, separators=(",", ":"))
print(f"Clipped {len(pieces)} OSM source pieces into {len(result)} land polygons.")
