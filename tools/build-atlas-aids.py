#!/usr/bin/env python3
"""Build the local NOTMAR supplement (requires BeautifulSoup and lxml).

Pass saved numbered Atlantic NOTMAR HTML sections for a reproducible build,
or omit them to fetch the current sections. See DATA-LICENSE.md.
"""

import argparse
from collections import Counter
from importlib import import_module
import json
from pathlib import Path
import re
from urllib.parse import urljoin
from urllib.request import urlopen

from bs4 import BeautifulSoup

signals = import_module("reconcile-atlas-signals")
ROOT = Path(__file__).resolve().parents[1]
INDEX = "https://notmar.gc.ca/list-lights"
SAMBRO = (-63.66, 44.38, -63.45, 44.50)
DMS = re.compile(r"(?<!\d)(\d{2,3})\s+(\d{2})\s+(\d{2}(?:\.\d+)?)(?!\d)")
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
            yield path, path.read_bytes()
        return
    index = BeautifulSoup(fetch(INDEX), "lxml")
    links = sorted({a["href"] for a in index.find_all("a", href=True)
                    if re.fullmatch(r"/publications/list-lights/atl/atl\d+-en\.php", a["href"])})
    if len(links) < 15:
        raise SystemExit("Expected numbered NOTMAR Atlantic sections in the index")
    for link in links:
        url = urljoin(INDEX, link)
        yield url, fetch(url)


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


def duplicate_light(coordinates, mark, intl, light):
    if mark["ll"] == light.get("ccg_id") or intl and intl == signals.international(light.get("intl") or ""):
        return True
    distance = signals.distance(coordinates, light["coordinates"])
    return distance <= .015 or (distance <= .12 and normalized(mark["n"]) == normalized(light["name"]))


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("sections", nargs="*", type=Path)
    parser.add_argument("--output", type=Path, default=ROOT / "web/aids.json")
    args = parser.parse_args()
    chart = json.loads((ROOT / "web/chart-data.json").read_text())
    bounds_text = re.search(r"const mapBounds = (\[.*\]);", (ROOT / "web/map.mjs").read_text())[1]
    bounds = sum(json.loads(bounds_text), [])
    features = []
    counts = Counter()
    sambro = Counter()
    seen = set()
    for source, html in sections(args.sections):
        rows = list(parse(html))
        if not rows:
            raise SystemExit(f"No positioned lit aids parsed from {source}")
        for coordinates, properties, intl in rows:
            kind = properties["k"]
            if not inside(coordinates, bounds) or properties["ll"] in seen:
                continue
            seen.add(properties["ll"])
            counts[kind] += 1
            local = inside(coordinates, SAMBRO)
            if local:
                sambro[kind] += 1
            if kind == "light" and any(duplicate_light(coordinates, properties, intl, light) for light in chart["lights"]):
                counts["existing lights"] += 1
                if local:
                    sambro["existing lights"] += 1
                continue
            features.append({"type": "Feature", "geometry": {"type": "Point",
                "coordinates": [round(x, 6) for x in coordinates]},
                "properties": {k: v for k, v in properties.items() if v}})
    if not features:
        raise SystemExit("No supplemental aids within the map bounds")
    features.sort(key=lambda f: float(f["properties"]["ll"]))
    out = {"type": "FeatureCollection", "features": features}
    temporary = args.output.with_suffix(".tmp")
    temporary.write_text(json.dumps(out, separators=(",", ":"), ensure_ascii=False) + "\n", encoding="utf-8")
    temporary.replace(args.output)
    print(f"NOTMAR Atlantic before dedup: map {dict(counts)}, Sambro {dict(sambro)}")
    print(f"{len(features)} supplemental aids, {args.output.stat().st_size:,} bytes")


if __name__ == "__main__":
    main()
