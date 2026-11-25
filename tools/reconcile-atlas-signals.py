"""Reconcile the live Atlas light metadata with Canadian Coast Guard lists."""
import argparse
import csv
from decimal import Decimal
import json
import math
from pathlib import Path
import re

from bs4 import BeautifulSoup

COLOR = r"[WRGY]"
BEARING = r"(\d{1,3})(?:°\s*|\s+)(?:(\d{1,2})\s*['′])?"
SPAN = rf"{BEARING}\s*(?:[-–—]|to)\s*{BEARING}"
SECONDS = r"(\d+(?:\.\d+)?)\s*(?:s\b|sec\b)"
# Published NGA Pub. 110 fills two omissions in the Canadian table.
# Entries 9648 and 9772, pages 86–87 of the 2026 edition.
NGA_FALLBACK = {"H3504": {"range": 17.0}, "H3534": {"period": 7.0}}
PHASE = re.compile(rf"\b(Flash(?:es)?|Fl\.|Eclipse|Ecl\.)\s*[:=]?\s*{SECONDS}", re.I)


def html_rows(path):
    active = {}
    for row in BeautifulSoup(path.read_bytes(), "lxml").find_all("tr"):
        cells = {}
        i = 0
        for cell in row.find_all("td", recursive=False):
            while i in active:
                i += 1
            text = cell.get_text(" | ", strip=True).replace("\xa0", " ")
            cells[i] = text
            length = int(cell.get("rowspan", 1))
            if length > 1:
                active[i] = (length, text)
            i += int(cell.get("colspan", 1))
        for i, (length, text) in list(active.items()):
            cells.setdefault(i, text)
            if length == 1:
                del active[i]
            else:
                active[i] = length - 1, text
        yield cells


def international(text):
    code = re.search(r"\bH\s*(\d+(?:\.\d+)?)", text)
    return "H" + format(Decimal(code[1]).normalize(), "f") if code else None


def decimal_angle(degree, minute):
    return int(degree) + int(minute or 0) / 60


def coastal_records(paths):
    numbers, references = {}, {}
    for path in paths:
        for cells in html_rows(path):
            identity = re.match(r"^(\d+(?:\.\d+)?)", cells.get(0, ""))
            coords = re.findall(r"(?<!\d)(\d{2,3})\s+(\d{2})\s+(\d{2}(?:\.\d+)?)(?!\d)", cells.get(3, ""))
            colors = list(dict.fromkeys(re.findall(rf"\b{COLOR}\b", cells.get(5, ""))))
            name = cells.get(1, "").split(" | ")[0]
            if not identity or len(coords) != 2 or not colors or re.search(r"\bbuoy\b", name, re.I):
                continue
            character = cells.get(4, "").split(" | ")[0].strip()
            # Group notation is useful for approximate timing when an exact
            # flash/eclipsing sequence was not published.
            base = re.match(r"^([A-Za-z]+)(?:\(([^)]+)\))?", character)
            if not base:
                continue
            period_entry = re.search(SECONDS, cells.get(6, ""))
            period = float(period_entry[1]) if period_entry else 0
            ranges = [float(value) for value in re.findall(r"\d+(?:\.\d+)?", cells.get(8, ""))]
            remarks = cells.get(10, "")
            primary = re.split(r"Emergency|Secondary|Fog Horn|Horn |Radar", remarks, maxsplit=1, flags=re.I)[0]
            sequence = [[float(item[1]), not item[0].lower().startswith("ecl")] for item in PHASE.findall(primary)]
            if not period or abs(sum(item[0] for item in sequence) - period) > .15 or not any(not item[1] for item in sequence):
                sequence = []
            sector_entries = re.findall(rf"\b({COLOR})\s*\|\s*{SPAN}", primary, flags=re.I)
            sectors = [[color.upper(), decimal_angle(sd, sm), decimal_angle(ed, em)]
                       for color, sd, sm, ed, em in sector_entries]
            if not sectors and len(colors) == 1:
                visible = re.search(rf"\bVisible\s+{SPAN}", primary, flags=re.I)
                if visible:
                    sectors = [[colors[0], decimal_angle(*visible.groups()[:2]), decimal_angle(*visible.groups()[2:])]]
            coordinates = [sum(float(value) / scale for value, scale in zip(parts, (1, 60, 3600))) for parts in coords]
            record = {
                "ccg_id": identity[1], "intl": international(cells[0]),
                "source": "Canadian Coast Guard", "coordinates": [-coordinates[1], coordinates[0]],
                "colors": colors, "character": base[1], "group": base[2] or "",
                "period": period, "range": max(ranges, default=0), "sequence": sequence, "sectors": sectors,
            }
            numbers[identity[1]] = record
            if record["intl"]:
                references[record["intl"]] = record
    return numbers, references


def distance(a, b):
    return math.hypot((a[0] - b[0]) * 79, (a[1] - b[1]) * 111)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("chart", type=Path)
    parser.add_argument("osm", type=Path)
    parser.add_argument("coast_guard_sections", nargs="+", type=Path)
    args = parser.parse_args()
    chart = json.loads(args.chart.read_text())
    tags = {f'{obj["type"]}/{obj["id"]}': obj["tags"] for obj in json.loads(args.osm.read_text())["elements"]}
    numbers, references = coastal_records(args.coast_guard_sections)
    with Path(__file__).with_name("atlas-lighthouses.csv").open() as f:
        inventory = {row["name"]: row for row in csv.DictReader(f)}
    used = {row["ccg_id"] for row in inventory.values() if row["ccg_id"]}
    for entry in chart["lights"]:
        row = inventory[entry["name"]]
        parsed_tags = tags.get(row["osm_ref"], {})
        referenced = references.get(international(parsed_tags.get("seamark:light:reference", "")))
        official = numbers.get(row["ccg_id"])
        if referenced and ((official and referenced["ccg_id"] == official["ccg_id"]) or
                           (not official and referenced["ccg_id"] not in used and
                            "historic" not in entry["name"].lower() and
                            distance(entry["coordinates"], referenced["coordinates"]) < .09)):
            official = referenced
        if not official:
            if "historic" in entry["name"].lower():
                entry.update(character="",period=0,range=0,sequence=[],sectors=[])
            continue
        used.add(official["ccg_id"])
        revised = dict(official)
        for field, value in NGA_FALLBACK.get(revised["intl"], {}).items():
            if not revised[field]:
                revised[field] = value
                revised[f"{field}_source"] = "NGA Pub. 110"
        candidate_character = parsed_tags.get("seamark:light:character") or parsed_tags.get("seamark:light:1:character")
        for field in ("period", "range"):
            value = parsed_tags.get(f"seamark:light:{field}") or parsed_tags.get(f"seamark:light:1:{field}") or ""
            if (not revised[field] and (field == "range" or
                    revised["character"] != "F" and candidate_character == revised["character"]) and
                    re.fullmatch(r"\d+(?:\.\d+)?", value.strip())):
                revised[field] = float(value)
                revised[f"{field}_source"] = "OpenStreetMap"
        # Keep a complete OSM timing sequence as a fallback only when its
        # official character and period agree.
        if not revised["sequence"] and (entry["character"], entry["period"]) == (revised["character"], revised["period"]):
            revised["sequence"] = entry["sequence"]
        entry.update(revised)
    # Hand-checked corrections for lights the Coast Guard list doesn't cover.
    overrides = json.loads(Path(__file__).with_name("atlas-light-overrides.json").read_text())
    for entry in chart["lights"]:
        entry.update(overrides.get(entry["name"], {}))
    args.chart.write_text(json.dumps(chart, separators=(",", ":")) + "\n")
    official_count = sum(light.get("source") == "Canadian Coast Guard" for light in chart["lights"])
    print(f"{official_count} lights reconciled with Canadian Coast Guard records")


if __name__ == "__main__":
    main()
