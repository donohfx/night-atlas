#!/usr/bin/env python3
"""Build the local NOTMAR supplement (requires BeautifulSoup and lxml).

Pass saved numbered NOTMAR HTML sections (atl*, nl*, iw*, arc*) for a
reproducible build, or omit them to fetch the current sections. Light numbers
repeat between volumes, so an aid is identified by volume and number. Atlantic
numbers stay bare; the others carry a prefix (NFD123, INL45, ARC1400), as chart
records do. See DATA-LICENSE.md.
"""

import argparse
from collections import Counter
from importlib import import_module
import json
import math
from pathlib import Path
import re
import time
from urllib.parse import urljoin
from urllib.request import urlopen

from bs4 import BeautifulSoup

signals = import_module("reconcile-atlas-signals")
ROOT = Path(__file__).resolve().parents[1]
INDEX = "https://notmar.gc.ca/list-lights"
DMS = re.compile(r"(?<!\d)(\d{2,3})\s+(\d{2})\s+(\d{2}(?:\.\d+)?)(?!\d)")
# volume file stem -> (index folder, light-number prefix, first and last number used)
VOLUMES = {"atl": ("atl", "", 0, math.inf),
           "nl": ("newfoundland", "NFD", 0, math.inf),
           "iw": ("inland-waters", "INL", 0, 401),             # Montreal to Kingston
           "arc": ("arc", "ARC", 1345, 1900)}                  # Nunatsiavut
BAND = {"red": "R", "green": "G", "yellow": "Y", "black": "B", "white": "W"}


def inside(point, bounds):
    x, y = point
    w, s, e, n = bounds
    return w <= x <= e and s <= y <= n


def fetch(url):
    with urlopen(url, timeout=30) as response:
        return response.read()


def sections(paths):
    if paths:
        for path in paths:
            yield path.name, path.read_bytes()
        return
    index = BeautifulSoup(fetch(INDEX), "lxml")
    hrefs = {a["href"] for a in index.find_all("a", href=True)}
    for stem, (folder, *_) in VOLUMES.items():
        links = sorted(h for h in hrefs
                       if re.fullmatch(rf"/publications/list-lights/{folder}/{stem}\d+-en\.php", h))
        if len(links) < (15 if stem == "atl" else 5):
            raise SystemExit(f"Expected numbered NOTMAR {stem} sections in the index")
        for link in links:
            url = urljoin(INDEX, link)
            time.sleep(1)
            yield url.rsplit("/", 1)[1], fetch(url)


def volume(name):
    match = re.match(r"(atl|nl|iw|arc)\d", name)
    if not match:
        raise SystemExit(f"Cannot tell which List of Lights volume {name} belongs to")
    return VOLUMES[match[1]][1:]


def parse(html):
    soup = BeautifulSoup(html, "lxml")
    modified = soup.select_one('time[property="dateModified"]')
    edition = modified.get_text(strip=True) if modified else ""
    for cells in signals.html_rows(html):
        ll = re.match(r"^(\d+(?:\.\d+)?)(?:\s*\||$)", cells.get(0, ""))
        name = cells.get(1, "").replace(" | ", " ")
        coords = DMS.findall(cells.get(3, ""))
        character = re.match(r"([A-Za-z]+)\s*(?:\(([^)]+)\))?", cells.get(4, ""))
        colors = re.findall(r"\b(?:W|R|G|Y|Bu)\b", cells.get(5, ""))
        if not ll or not name or len(coords) != 2 or not character or not colors:
            continue
        lat, west_lon = (sum(float(n) / scale for n, scale in zip(angle, (1, 60, 3600))) for angle in coords)
        desc = cells.get(9, "").replace(" | ", " ")
        markings = re.match(r"^((?:red|green|black|white|yellow)(?:[- /]+(?:red|green|black|white|yellow))*)\s*[,;.]", desc, re.I)
        bands = "".join(BAND[c] for c in re.findall(r"[a-z]+", markings[1].lower())) if markings else ""
        code = re.search(r"\bmarked\s+[“\"]([A-Z0-9 -]+)[”\"]", desc, re.I)
        shape = re.search(r"\b(conical|can|spar|pillar|barrel|spherical|cylindrical|superbuoy)\b", desc, re.I)
        kind = "buoy" if re.search(r"\bbuoy\b", name, re.I) else "light"
        period = re.search(signals.SECONDS, cells.get(6, ""))
        period = float(period[1]) if period else 0
        remarks = re.split(r"Emergency|Secondary|Fog Horn|Horn |Radar", cells.get(10, ""), maxsplit=1, flags=re.I)[0]
        sequence = [[float(item[1]), not item[0].lower().startswith("ecl")] for item in signals.PHASE.findall(remarks)]
        if not period or abs(sum(item[0] for item in sequence) - period) > .02 or not any(not item[1] for item in sequence):
            sequence = []
        p = {"k": kind, "n": name, "ref": code[1] if code else "", "ll": ll[1],
             "lit": 1, "lc": colors[0], "lcs": "/".join(dict.fromkeys(colors)),
             "lch": character[1], "lg": character[2] or "",
             "lp": period, "seq": sequence,
             "cs": bands if kind == "buoy" else "",
             "s": shape[1].lower() if shape and kind == "buoy" else "",
             "date": edition}
        yield [-west_lon, lat], p, signals.international(cells[0])


def normalized(name):
    return re.sub(r"[^a-z0-9]", "", re.sub(r"\b(?:lighthouse|lightstation|light)\b", "", name.lower()))


def same_aid(a, b):
    """One physical aid listed in two volumes: same place, name and signal."""
    (xy, p), (other, q) = a, b
    return (signals.distance(xy, other) <= .015 and normalized(p["n"]) == normalized(q["n"])
            and all(p[key] == q[key] for key in ("k", "lcs", "lch", "lp")))


def duplicate_light(coordinates, mark, intl, light):
    if mark["ll"] == light.get("ccg_id") or intl and intl == signals.international(light.get("intl") or ""):
        return True
    distance = signals.distance(coordinates, light["coordinates"])
    return distance <= .015 or (distance <= .12 and normalized(mark["n"]) == normalized(light["name"]))


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("sections", nargs="*", type=Path)
    parser.add_argument("--output", type=Path, default=ROOT / "web/aids.json")
    parser.add_argument("--bounds", nargs=4, type=float, metavar=("W", "S", "E", "N"),
                        help="default: mapBounds in web/atlas-core.mjs")
    parser.add_argument("--dropped", type=Path, help="write every aid left out as a duplicate, with the reason")
    args = parser.parse_args()
    chart = json.loads((ROOT / "web/chart-data.json").read_text())
    bounds = args.bounds
    if not bounds:
        text = re.search(r"const mapBounds = (\[.*\]);", (ROOT / "web/atlas-core.mjs").read_text())[1]
        bounds = sum(json.loads(text), [])
    features = []
    counts = Counter()
    seen = {}
    placed = {}
    dropped = []
    for source, html in sections(args.sections):
        prefix, first, last = volume(source)
        rows = list(parse(html))
        if not rows and not prefix:
            raise SystemExit(f"No positioned lit aids parsed from {source}")
        for coordinates, properties, intl in rows:
            kind, number = properties["k"], float(properties["ll"])
            if not (first <= number <= last) or not inside(coordinates, bounds):
                continue
            properties["ll"] = key = prefix + properties["ll"]
            drop = lambda reason: dropped.append({"ll": key, "name": properties["n"],
                                                  "coordinates": coordinates, "reason": reason})
            if key in seen:
                if any(same_aid(other, (coordinates, properties)) for other in seen[key]):
                    continue
                # The volume reuses a number for a different aid: keep both, told apart by a suffix.
                seen[key].append((coordinates, properties))
                properties["ll"] = key = f"{key}#{len(seen[key])}"
                counts["reused numbers kept"] += 1
            else:
                seen[key] = [(coordinates, properties)]
            cell = tuple(math.floor(value * 100) for value in coordinates)
            nearby = (item for dx in (-1, 0, 1) for dy in (-1, 0, 1)
                      for item in placed.get((cell[0] + dx, cell[1] + dy), []))
            twin = next((item for item in nearby if item[0] != prefix
                         and same_aid(item[1:], (coordinates, properties))), None)
            if twin:
                drop("same aid as " + twin[2]["ll"])
                counts["listed in two volumes"] += 1
                continue
            placed.setdefault(cell, []).append((prefix, coordinates, properties))
            counts[kind] += 1
            if kind == "light":
                existing = next((light for light in chart["lights"]
                                 if duplicate_light(coordinates, properties, intl, light)), None)
                if existing:
                    drop("hand-checked lighthouse " + existing["name"])
                    counts["existing lights"] += 1
                    continue
            features.append({"type": "Feature", "geometry": {"type": "Point",
                "coordinates": [round(x, 6) for x in coordinates]},
                "properties": {k: v for k, v in properties.items() if v}})
    if not features:
        raise SystemExit("No supplemental aids within the map bounds")
    def order(feature):
        prefix, number = re.fullmatch(r"([A-Z]*)([\d.]+)(?:#\d+)?", feature["properties"]["ll"]).groups()
        return prefix, float(number)
    features.sort(key=order)
    out = {"type": "FeatureCollection", "features": features}
    temporary = args.output.with_suffix(".tmp")
    temporary.write_text(json.dumps(out, separators=(",", ":"), ensure_ascii=False) + "\n", encoding="utf-8")
    temporary.replace(args.output)
    if args.dropped:
        args.dropped.write_text(json.dumps(dropped, indent=1, ensure_ascii=False) + "\n", encoding="utf-8")
    print(f"NOTMAR within bounds: {dict(counts)}")
    print(f"{len(features)} supplemental aids, {args.output.stat().st_size:,} bytes")


if __name__ == "__main__":
    main()
