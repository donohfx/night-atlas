#!/usr/bin/env python3
"""Build additive web-only St. Lawrence aid bundles from saved sources."""

import argparse
from importlib import import_module
import json
from pathlib import Path

aids_builder = import_module("build-atlas-aids")
matcher = import_module("build-atlas-buoy-matches")
WEB = aids_builder.ROOT / "web"
REGION = WEB / "region"
AREAS = ("gulf", "lower", "upper")
QUEBEC_CITY = -71.30
MONTREAL = -73.53
# Bounds for the supplied harvest, avoiding Lake Ontario, Ottawa and the
# Rideau. Include both sides of the international navigation channel.
UPPER_RIVER = [
    (-76.55, 44.17), (-76.48, 44.09), (-76.22, 44.02),
    (-75.63, 44.25), (-75.13, 44.68), (-74.71, 44.92),
    (-74.40, 44.97), (-73.96, 45.20), (-73.53, 45.38),
    (-73.53, 45.59), (-73.99, 45.52), (-74.40, 45.28),
    (-74.87, 45.08), (-75.20, 44.89), (-75.85, 44.57),
    (-76.28, 44.40), (-76.55, 44.28),
]


def read(path):
    return json.loads(path.read_text())


def features(path):
    return read(path)["features"]


def ll(feature):
    return feature["properties"].get("ll")


def xy(feature):
    return tuple(feature["geometry"]["coordinates"])


def main():
    from shapely.geometry import Point, Polygon
    from shapely import make_valid, union_all
    from shapely.affinity import scale
    from shapely.geometry import shape
    from shapely.strtree import STRtree
    import shapefile

    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("harvest", type=Path)
    parser.add_argument("aids", type=Path, help="Complete local List of Lights output")
    parser.add_argument("admin", type=Path, help="Natural Earth Admin 1 shapefile")
    parser.add_argument("stage", choices=AREAS)
    args = parser.parse_args()

    bounds = read(REGION / "config.json")["dataBounds"]
    outlines = {}
    with shapefile.Reader(args.admin) as source:
        for record in source.iterShapeRecords(bbox=bounds):
            if record.record["adm0_a3"] not in ("CAN", "USA"):
                continue
            code = record.record["iso_3166_2"]
            outlines.setdefault(code, []).append(make_valid(shape(record.shape.__geo_interface__)))
    codes = list(outlines)
    longitude_scale = .65
    tree = STRtree([scale(union_all(outlines[code]), xfact=longitude_scale, origin=(0, 0))
                    for code in codes])
    upper = Polygon(UPPER_RIVER)

    def area(mark, chart):
        x, y = xy(mark)
        if chart and not aids_builder.inside((x, y), bounds):
            return None
        if not chart and ll(mark).startswith("INL"):
            return "upper"
        if x < MONTREAL:
            return "upper" if chart and upper.covers(Point(x, y)) else "lower"
        if x < QUEBEC_CITY:
            return "lower" if not chart or 45.3 <= y <= 47.3 else None
        if not chart:
            return "gulf"
        # Select new Quebec waters using the same distance model as NL.
        # Include the Quebec City approaches on either side of the river.
        nearest = tree.query_nearest(Point(x * longitude_scale, y))
        return "gulf" if all(codes[index] == "CA-QC" for index in nearest) else None

    stages = AREAS[:AREAS.index(args.stage)]
    previous = [read(REGION / f"river-{stage}.json") for stage in stages]
    old_marks = [*features(REGION / "chs-marks.json"), *(f for part in previous for f in part["marks"])]
    marks = []
    for feature in features(args.harvest):
        if area(feature, chart=True) != args.stage:
            continue
        p = feature["properties"]
        candidates = (f for f in old_marks if f["properties"]["k"] == p["k"])
        if any((xy(f) == xy(feature) and
                (not p.get("n") or not f["properties"].get("n") or p["n"].casefold() == f["properties"]["n"].casefold()))
               or (p.get("n") and p["n"].casefold() == f["properties"].get("n", "").casefold()
                   and matcher.meters(f, feature) <= 100)
               or (ll(feature) and ll(feature) == ll(f) and matcher.meters(f, feature) <= 1000)
               for f in candidates):
            continue
        marks.append(feature)

    old_aids = {ll(f): f for f in features(REGION / "aids.json")}
    legacy_aids = {ll(f) for f in features(WEB / "aids.json")}
    additions = []
    for feature in features(args.aids):
        if area(feature, chart=False) != args.stage:
            continue
        if ll(feature) in old_aids:
            if xy(old_aids[ll(feature)]) != xy(feature):
                raise ValueError(f"Supplement reuses {ll(feature)} at a different position")
            continue
        additions.append(feature)

    matches = matcher.build([f for f in [*old_marks, *marks] if f["properties"]["k"] == "buoy"],
                            [f for f in additions if f["properties"]["k"] == "buoy" and ll(f) not in legacy_aids])
    baseline_matches = read(REGION / "ccg-buoy-matches.json")
    used = {(tuple(o["coordinates"]), o["name"]) for part in [baseline_matches, *(p["matches"] for p in previous)]
            for o in part["overrides"]}
    matches["overrides"] = [o for o in matches["overrides"] if (tuple(o["coordinates"]), o["name"]) not in used]
    path = REGION / f"river-{args.stage}.json"
    path.write_text(json.dumps({"marks": marks, "aids": additions, "matches": matches},
                               ensure_ascii=False, separators=(",", ":")) + "\n")
    print(f"{args.stage}: {len(marks)} new chart marks, {len(additions)} new aids, {path.stat().st_size:,} bytes")


if __name__ == "__main__":
    main()
