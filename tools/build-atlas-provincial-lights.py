#!/usr/bin/env python3
"""Build the web-only provincial lights from checked-in source extracts."""

import argparse
from collections import defaultdict
from importlib import import_module
import json
import math
from pathlib import Path
import re
import unicodedata

ROOT = Path(__file__).resolve().parents[1]
PROVINCES = ROOT / "tools/provinces"


def load(path):
    return json.loads(path.read_text())


def write(path, value):
    path.write_text(json.dumps(value, ensure_ascii=False, indent=2) + "\n")


def metres(a, b):
    return math.hypot((a[0] - b[0]) * math.cos(math.radians((a[1] + b[1]) / 2)),
                      a[1] - b[1]) * 111195


def normalized(name):
    name = unicodedata.normalize("NFKD", name.lower())
    name = "".join(c for c in name if not unicodedata.combining(c))
    name = re.sub(r"\b(?:lighthouse|lightstation|light|phare|de|du|des|la|le|the)\b", "", name)
    return re.sub(r"[^a-z0-9]", "", name)


def references(text):
    return {f"{letter.upper()}{float(number):g}"
            for letter, number in re.findall(r"\b([A-Z])\s*(\d+(?:\.\d+)?)\b", text, re.I)}


def aid_identity(aid):
    return f"{aid['volume']}:{aid['ccg_id']}"


def osm_extract(path, source):
    import osmium

    class Lighthouses(osmium.SimpleHandler):
        def __init__(self):
            super().__init__()
            self.elements = []

        def add(self, kind, obj, locations):
            if obj.tags.get("man_made") != "lighthouse" or not locations:
                return
            coordinates = [round(sum(axis) / len(locations), 7) for axis in zip(*locations)]
            tags = {key: value for key, value in obj.tags if
                    key.startswith(("name", "alt_name", "official_name", "ref", "seamark:")) or
                    key in ("man_made", "historic", "disused", "tourism", "description", "wikidata")}
            self.elements.append({"id": f"{kind}/{obj.orig_id() if kind == 'relation' else obj.id}",
                                  "coordinates": coordinates, "tags": tags})

        def node(self, node):
            self.add("node", node, [(node.lon, node.lat)])

        def way(self, way):
            if way.tags.get("man_made") == "lighthouse":
                self.add("way", way, [(n.lon, n.lat) for n in way.nodes if n.location.valid()])

        def area(self, area):
            if not area.from_way() and area.tags.get("man_made") == "lighthouse":
                self.add("relation", area, [(n.lon, n.lat) for ring in area.outer_rings()
                                             for n in ring if n.location.valid()])

    handler = Lighthouses()
    handler.apply_file(str(path), locations=True)
    return {"source": source, "elements": sorted(handler.elements, key=lambda e: e["id"])}


def ccg_extract(paths, towers, aids):
    parser = import_module("build-atlas-aids")
    signals = parser.signals
    rows = []
    for path, html in parser.sections(sorted(paths)):
        volume, *_ = parser.volume(path)
        for cells in signals.html_rows(html):
            number = re.match(r"^(\d+(?:\.\d+)?)(?:\s*\||$)", cells.get(0, ""))
            angles = parser.DMS.findall(cells.get(3, ""))
            name = re.split(r" \| (?:Racon|Fog Horn)\b", cells.get(1, ""), maxsplit=1, flags=re.I)[0].replace(" | ", " ")
            if not number or len(angles) != 2 or not name or re.search(r"\bbuoy\b", name, re.I):
                continue
            y, x = [sum(float(v) / scale for v, scale in zip(angle, (1, 60, 3600))) for angle in angles]
            xy = [-x, y]
            intl = signals.international(cells[0])
            if not any(metres(xy, tower["coordinates"]) <= 3000 or
                       intl and intl in tower_refs(tower) for tower in towers):
                continue
            character = re.match(r"([A-Za-z]+)\s*(?:\(([^)]+)\))?", cells.get(4, ""))
            colors = list(dict.fromkeys(re.findall(r"\b(?:W|R|G|Y|Bu)\b", cells.get(5, ""))))
            if not character or not colors:
                continue
            period = re.fullmatch(r"(\d+(?:\.\d+)?)\s*(?:s|sec)?", cells.get(6, ""))
            period = float(period[1]) if period else None
            ranges = [float(piece) for piece in cells.get(8, "").split(" | ")
                      if re.fullmatch(r"\d+(?:\.\d+)?", piece)]
            remarks = cells.get(10, "")
            primary = re.split(r"Emergency|Secondary|Fog Horn|Horn |Radar", remarks, maxsplit=1, flags=re.I)[0]
            sequence = [[float(duration), not phase.lower().startswith("ecl")]
                        for phase, duration in signals.PHASE.findall(primary)]
            if not period or abs(sum(duration for duration, _ in sequence) - period) > .02 or all(
                    on for _, on in sequence):
                sequence = []
            sectors = [[color.upper(), signals.decimal_angle(sd, sm), signals.decimal_angle(ed, em)]
                       for color, sd, sm, ed, em in re.findall(
                           rf"\b({signals.COLOR})\s*(?:\|\s*)?{signals.SPAN}", primary, re.I)]
            if not sectors and len(colors) == 1:
                visible = re.search(rf"\bVisible\s+{signals.SPAN}", primary, re.I)
                if visible:
                    sectors = [[colors[0], signals.decimal_angle(*visible.groups()[:2]),
                                signals.decimal_angle(*visible.groups()[2:])]]
            number = volume + number[1]
            aid_ids = [a["properties"]["ll"] for a in aids if a["properties"]["k"] == "light"
                       and a["properties"]["ll"].split("#")[0] == number
                       and metres(a["geometry"]["coordinates"], xy) <= 1]
            if len(aid_ids) > 1:
                raise ValueError(f"Ambiguous supplemental aid identity for {name}: {aid_ids}")
            rows.append({"volume": volume or "atlantic", "ccg_id": aid_ids[0] if aid_ids else number,
                         "name": name, "coordinates": xy, "intl": intl, "colors": colors,
                         "character": character[1], "group": character[2] or "", "period": period,
                         "range": max(ranges, default=None), "sequence": sequence, "sectors": sectors,
                         "section": path, "structure": cells.get(9, ""), "remarks": remarks})
    return rows


def tower_refs(tower):
    return {ref for key, value in tower["tags"].items()
            if key.startswith("ref") or key.endswith(":reference") or key == "seamark:lnam"
            for ref in references(value)}


def tower_names(tower):
    return {normalized(value) for key, value in tower["tags"].items()
            if (key.startswith(("name", "alt_name", "official_name")) or key == "seamark:name") and normalized(value)}


def match(tower, rows, config, override):
    distances = sorted((metres(tower["coordinates"], row["coordinates"]), index, row)
                       for index, row in enumerate(rows))
    near = [(round(distance, 1), aid_identity(row), row["name"])
            for distance, _, row in distances if distance <= config["reviewRadius"]]
    if override:
        if override.get("aid") is None:
            return None, override["reason"], near
        chosen, = [row for _, _, row in distances if aid_identity(row) == override["aid"]]
        return chosen, f"reviewed override: {override['reason']}", near
    refs = tower_refs(tower)
    exact = [(distance, row) for distance, _, row in distances if row["intl"] in refs]
    if len(exact) == 1 and exact[0][0] <= config["referenceRadius"]:
        return exact[0][1], "international reference", near
    if exact:
        return None, "doubtful international reference", near
    names = tower_names(tower)
    named = [row for distance, _, row in distances if distance <= config["nameRadius"]
             and normalized(row["name"]) in names]
    if len(named) == 1:
        return named[0], "distance and name", near
    if refs:
        return None, "OSM reference absent from the Coast Guard extract", near
    return None, "doubtful nearby aids" if near else "no nearby Coast Guard light", near


def mark_keys(row, tower, assets):
    xy = row["coordinates"]
    names = tower_names(tower) | {normalized(row["name"])}
    for source, features in assets.items():
        for feature in features:
            p = feature["properties"]
            coordinates = feature["geometry"]["coordinates"]
            if feature["geometry"]["type"] != "Point" or p.get("k") != ("light" if source == "ccg" else "beacon"):
                continue
            ll, name = p.get("ll", ""), p.get("n", "")
            distance = metres(xy, coordinates)
            if source == "ccg":
                duplicate = ll == row["ccg_id"] and distance <= 2
            elif source == "chs":
                duplicate = (ll == row["ccg_id"] and distance <= 100) or (
                    not ll and distance <= 12 and (p.get("lit") or normalized(name) in names))
            else:
                duplicate = not ll and distance <= 100 and normalized(name) in names
            if duplicate:
                yield [p.get("src", source), ll, name, coordinates]


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--osm-pbf", type=Path)
    parser.add_argument("--ccg-html", nargs="+", type=Path)
    parser.add_argument("--province", default="nb", help="province for refreshing source snapshots")
    args = parser.parse_args()
    assets = {source: load(ROOT / "web" / path)["features"] for source, path in {
        "ccg": "region/aids.json", "chs": "region/chs-marks.json", "osm": "seamarks.json"}.items()}
    for path in sorted((ROOT / "web/region").glob("river-*.json")):
        bundle = load(path)
        assets["ccg"].extend(bundle["aids"])
        assets["chs"].extend(bundle["marks"])
    original = load(ROOT / "web/chart-data.json")["lights"]
    grouped = defaultdict(list)
    marks = []
    for config_path in sorted(PROVINCES.glob("*.config.json")):
        config = load(config_path)
        code = config_path.name.split(".")[0]
        osm_path, ccg_path, review_path = [PROVINCES / f"{code}.{kind}.json" for kind in ("osm", "ccg", "review")]
        if args.osm_pbf and args.province == code:
            write(osm_path, osm_extract(args.osm_pbf, config["osmSource"]))
        towers = load(osm_path)["elements"]
        if args.ccg_html and args.province == code:
            write(ccg_path, ccg_extract(args.ccg_html, towers, assets["ccg"]))
        rows = load(ccg_path)
        review = []
        for tower in towers:
            override = config["overrides"].get(tower["id"])
            row, method, near = match(tower, rows, config, override)
            item = {"osm": tower["id"], "name": tower["tags"].get("name"), "method": method,
                    "references": sorted(tower_refs(tower)), "candidates": near}
            if override and override.get("source"):
                item["source"] = override["source"]
            review.append(item)
            if not row:
                continue
            duplicate = any(row["intl"] and row["intl"] == light.get("intl") or
                            row["ccg_id"] == light.get("ccg_id") and row["volume"] == "atlantic"
                            for light in original)
            if duplicate:
                item["method"] += "; already in Nova Scotia inventory"
                continue
            item["aid"] = aid_identity(row)
            item["distanceMetres"] = round(metres(tower["coordinates"], row["coordinates"]), 1)
            if item["distanceMetres"] > config["nameRadius"]:
                item["review"] = "Position discrepancy; rendered at the published Coast Guard position."
            item["marks"] = list(mark_keys(row, tower, assets))
            grouped[aid_identity(row)].append((row, tower, override, item))
        write(review_path, review)

    lights = []
    for identity, matches in sorted(grouped.items()):
        row, tower, override, _ = min(matches, key=lambda item: metres(item[0]["coordinates"], item[1]["coordinates"]))
        name = row["name"]
        if not re.search(r"lighthouse|lightstation|range|wharf|breakwater", name, re.I):
            name += " Lighthouse"
        light = {k: v for k, v in row.items() if k not in ("section", "structure", "remarks")}
        light.update(name=name, source="Canadian Coast Guard", osm=tower["id"])
        light.update((override or {}).get("light", {}))
        lights.append(light)
        for _, _, _, item in matches:
            for key in item["marks"]:
                if key not in marks:
                    marks.append(key)
    output = ROOT / "web/region/lights.json"
    staged = output.with_suffix(".tmp")
    staged.write_text(json.dumps(
        {"lights": lights, "marks": marks}, ensure_ascii=False, separators=(",", ":")) + "\n")
    staged.replace(output)
    print(f"{len(lights)} lighthouse signals; {len(marks)} duplicate marks suppressed in combined mode")


if __name__ == "__main__":
    main()
