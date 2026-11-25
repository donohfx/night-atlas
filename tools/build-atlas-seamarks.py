#!/usr/bin/env python3
"""Night Atlas: charted features (buoys, beacons, ferry routes, traffic separation) from
OpenStreetMap/OpenSeaMap via Overpass, clipped to the chart's relief bounds.

    python tools/build-atlas-seamarks.py web

Writes <live>/seamarks.json (GeoJSON FeatureCollection, compact properties).
Data: (c) OpenStreetMap contributors, ODbL.
"""
import json
import sys
import time
import urllib.parse
import urllib.request
from pathlib import Path

LIVE = Path(sys.argv[1]).expanduser()
WEST, SOUTH, EAST, NORTH = json.loads((LIVE / "chart-data.json").read_text())["reliefBounds"]
BBOX = f"{SOUTH},{WEST},{NORTH},{EAST}"
QUERY = f"""[out:json][timeout:180];
(
  node["seamark:type"~"^(buoy|beacon)_"]({BBOX});
  way["route"="ferry"]({BBOX});
  way["seamark:type"~"^separation_(line|boundary|lane|zone)$"]({BBOX});
  relation["seamark:type"~"^separation_(lane|zone|scheme)$"]({BBOX});
);
out geom tags;"""
SERVERS = ["https://overpass-api.de/api/interpreter", "https://overpass.private.coffee/api/interpreter"]

COLOURS = {"red": "R", "green": "G", "yellow": "Y", "black": "B", "white": "W", "orange": "Y"}


def fetch():
    body = urllib.parse.urlencode({"data": QUERY}).encode()
    for attempt in range(6):
        url = SERVERS[attempt % len(SERVERS)]
        try:
            request = urllib.request.Request(url, body, {"User-Agent": "night-atlas-build/1.0"})
            with urllib.request.urlopen(request, timeout=240) as response:
                return json.load(response)["elements"]
        except Exception as error:  # Overpass 429/502/504 are routine; back off and retry
            print(f"overpass {url}: {error}; retrying", file=sys.stderr)
            time.sleep(10 * (attempt + 1))
    raise SystemExit("Overpass unavailable")


def r(value):
    return round(value, 5)


def line(geometry):
    return [[r(p["lon"]), r(p["lat"])] for p in geometry]


features = []
for element in fetch():
    tags = element.get("tags", {})
    kind = tags.get("seamark:type", "")
    if element["type"] == "node":
        family = "beacon" if kind.startswith("beacon") else "buoy"
        colour = tags.get(f"seamark:{kind}:colour", "")
        name = tags.get("seamark:name") or tags.get("name") or ""
        light = lambda key: tags.get(f"seamark:light:{key}") or tags.get(f"seamark:light:1:{key}") or ""
        bands = [COLOURS.get(c.strip(), "") for c in colour.split(";") if c.strip()][:4]
        features.append({"type": "Feature", "geometry": {"type": "Point", "coordinates": [r(element["lon"]), r(element["lat"])]},
                         "properties": {"k": family, "c": bands[0] if bands else "", "cs": "".join(b or "-" for b in bands),
                                        "pat": tags.get(f"seamark:{kind}:colour_pattern", ""),
                                        "s": tags.get(f"seamark:{kind}:shape", ""),
                                        "cat": tags.get(f"seamark:{kind}:category", ""), "n": name,
                                        "lit": int(bool(light("character") or light("colour"))),
                                        "lc": COLOURS.get(light("colour").split(";")[0], ""), "lch": light("character"),
                                        "lp": light("period"), "lg": light("group")}})
    elif element["type"] == "way" and "geometry" in element:
        coords = line(element["geometry"])
        if tags.get("route") == "ferry":
            features.append({"type": "Feature", "geometry": {"type": "LineString", "coordinates": coords},
                             "properties": {"k": "ferry", "n": tags.get("name", "")}})
        elif kind.startswith("separation_"):
            closed = coords[0] == coords[-1] and len(coords) > 3
            geometry = {"type": "Polygon", "coordinates": [coords]} if closed and kind.endswith(("zone", "lane")) \
                else {"type": "LineString", "coordinates": coords}
            features.append({"type": "Feature", "geometry": geometry, "properties": {"k": kind}})
    elif element["type"] == "relation":
        for member in element.get("members", []):
            if member.get("type") == "way" and "geometry" in member:
                features.append({"type": "Feature", "geometry": {"type": "LineString", "coordinates": line(member["geometry"])},
                                 "properties": {"k": "separation_line"}})

out = LIVE / "seamarks.json"
out.write_text(json.dumps({"type": "FeatureCollection", "features": features}, separators=(",", ":")))
counts = {}
for f in features:
    counts[f["properties"]["k"]] = counts.get(f["properties"]["k"], 0) + 1
print(f"wrote {out} ({out.stat().st_size // 1024} KB): {counts}")
