#!/usr/bin/env python3
"""Cut selected OSM river water from the regional land and focus masks, then
split the Ontario and US focus masks along the OSM boundary in the upper river."""

import argparse
import json
from pathlib import Path

from shapely import box, make_valid, union_all
from shapely.geometry import LineString, Polygon, mapping, shape
from shapely.geometry.polygon import orient
from shapely.ops import linemerge, polygonize


# The main channel, its navigable branches, the Saguenay and the eastern end of
# Lake Ontario within the already charted box.
RELATIONS = {
    1206310, 1701670, 1769291, 1775822, 1797099, 1808142, 2426031, 4641113,
    6319634, 6448219, 11563382, 14036016, 14042253, 14045832, 14048280,
    14062946, 16740072, 16740073, 20020954,
    # Iroquois, Brockville and the narrows below the Thousand Islands.
    14035280, 14037369, 14039201, 14040790,
    # Saguenay.
    1563926, 1565088, 1575130, 1575134, 1575135, 1575162, 1575271,
}
# Closed ways: part of the Saguenay and the Montreal South Shore Canal approach.
WAYS = {112084761, 128587006, 129895381, 129895402, 129896286}
# The OSM boundary of New York leaves the river for the 45th parallel here.
# Natural Earth's straight segments upstream of it cross the river and its banks.
RIVER_END = -74.663


def polygons(geometry):
    if geometry.geom_type == "Polygon":
        if not geometry.is_empty:
            yield orient(geometry, sign=1)
    elif hasattr(geometry, "geoms"):
        for part in geometry.geoms:
            yield from polygons(part)


def relation_polygon(relation):
    rings = {"outer": [], "inner": []}
    for member in relation["members"]:
        if member["type"] != "way" or member["role"] not in rings:
            continue
        rings[member["role"]].append(LineString([(p["lon"], p["lat"]) for p in member["geometry"]]))
    def area(lines):
        return union_all(list(polygonize(linemerge(lines)))) if lines else union_all([])
    outer = area(rings["outer"])
    if outer.is_empty:
        # Some open boundary segments are tagged inner in OSM; they close the outer ring.
        segments = [line for line in rings["inner"] if not line.is_closed]
        rings["inner"] = [line for line in rings["inner"] if line.is_closed]
        outer = area(rings["outer"] + segments)
    if outer.is_empty:
        raise ValueError(f"No polygon for OSM relation {relation['id']}")
    return make_valid(outer.difference(area(rings["inner"])))


def way_polygon(way):
    points = [(p["lon"], p["lat"]) for p in way["geometry"]]
    if points[0] != points[-1]:
        raise ValueError(f"OSM way {way['id']} is not closed")
    return make_valid(Polygon(points))


def north_of_border(ways, bounds):
    """The area on the Ontario side of the boundary, west of RIVER_END."""
    merged = linemerge([LineString([(p["lon"], p["lat"]) for p in way["geometry"]]) for way in ways])
    if merged.geom_type != "LineString":
        raise ValueError("The boundary ways do not form one line")
    line = list(merged.coords)
    if line[0][0] > line[-1][0]:
        line.reverse()
    line = [point for point in line if point[0] <= RIVER_END]
    west, top = bounds[0], 45.2
    area = Polygon([*line, (RIVER_END, line[-1][1]), (RIVER_END, top), (west, top), (west, line[0][1])])
    if not area.is_valid:
        raise ValueError("The boundary does not enclose a simple area")
    return area, box(west, line[0][1], RIVER_END, top)


def split_border(path, north, extent):
    original = json.loads(path.read_text())
    updated = []
    for feature in original["features"]:
        region = feature["properties"]["region"]
        land = shape(feature["geometry"])
        if region not in ("US", "CA-ON") or not land.intersects(extent):
            updated.append(feature)
            continue
        for part, owner in ((land.difference(extent), region), (land.intersection(north), "CA-ON"),
                            (land.intersection(extent).difference(north), "US")):
            for polygon in polygons(part):
                updated.append({**feature, "properties": {**feature["properties"], "region": owner},
                                "geometry": mapping(polygon)})
    temporary = path.with_suffix(".tmp")
    temporary.write_text(json.dumps({**original, "features": updated},
                                    ensure_ascii=False, separators=(",", ":")) + "\n")
    temporary.replace(path)
    print(f"{path}: boundary split, {len(updated)} polygons")


def cut_file(path, water):
    original = json.loads(path.read_text())
    updated = []
    for feature in original["features"]:
        land = shape(feature["geometry"])
        if not water.intersects(land) or not water.intersection(land).area:
            updated.append(feature)
            continue
        for polygon in polygons(land.difference(water)):
            updated.append({**feature, "geometry": mapping(polygon)})
    temporary = path.with_suffix(".tmp")
    temporary.write_text(json.dumps({**original, "features": updated},
                                    ensure_ascii=False, separators=(",", ":")) + "\n")
    temporary.replace(path)
    print(f"{path}: {len(original['features'])} → {len(updated)} polygons")


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("region", type=Path)
    parser.add_argument("overpass", type=Path, nargs="+",
                        help="Saved Overpass water queries with out geom")
    parser.add_argument("--border", type=Path, required=True,
                        help="Saved Overpass query for the ways of relation 61320 near the river")
    args = parser.parse_args()
    elements = [e for path in args.overpass for e in json.loads(path.read_text())["elements"]]
    relations = {r["id"]: r for r in elements if r["type"] == "relation" and r["id"] in RELATIONS}
    ways = {w["id"]: w for w in elements if w["type"] == "way" and w["id"] in WAYS}
    if relations.keys() != RELATIONS or ways.keys() != WAYS:
        raise ValueError(f"Missing OSM water: {(RELATIONS - relations.keys()) | (WAYS - ways.keys())}")
    bounds = json.loads((args.region / "config.json").read_text())["dataBounds"]
    parts = [relation_polygon(relations[id]) for id in sorted(relations)]
    parts += [way_polygon(ways[id]) for id in sorted(ways)]
    water = union_all([part.intersection(box(*bounds)) for part in parts]
                      ).simplify(.000025, preserve_topology=True)
    border = [e for e in json.loads(args.border.read_text())["elements"] if e["type"] == "way"]
    north, extent = north_of_border(border, bounds)
    for name in ("land.json", "provinces.json"):
        cut_file(args.region / name, water)
    split_border(args.region / "provinces.json", north, extent)


if __name__ == "__main__":
    main()
