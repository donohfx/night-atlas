#!/usr/bin/env python3
"""Refresh the reproducible CGNDB point snapshot from cached provincial ZIPs."""
import argparse
import collections
import csv
import gzip
import hashlib
import io
import json
from pathlib import Path
import urllib.request
import zipfile

ROOT = Path(__file__).resolve().parents[1]
BASE = "https://ftp.maps.canada.ca/pub/nrcan_rncan/vector/geobase_cgn_toponyme/prov_csv_eng/"
PROVINCES = ("qc", "ns", "nb", "nl", "pe", "on", "uf")
CATEGORIES = {
    "PROV": "region", "GEOG": "region", "MUN1": "municipality", "MUN2": "municipality",
    "CITY": "city", "TOWN": "town", "VILG": "village", "UNP": "hamlet", "IR": "hamlet",
    "LAKE": "lake", "RIV": "river", "RIVF": "river", "BAY": "bay", "CHAN": "channel",
    "SEA": "sea", "ISL": "island", "CAPE": "cape", "SHL": "shoal", "SEAU": "undersea",
    "SEAF": "undersea", "BCH": "beach", "FALL": "falls", "RAP": "rapids", "SPRG": "spring",
    "MTN": "peak", "VALL": "valley", "CLF": "cliff", "PLN": "plain", "PARK": "park",
    "FOR": "forest", "VEGL": "vegetation", "CAVE": "cave", "CRAT": "crater", "MAR": "marina",
}
# Several federally approved bilingual pairs have language code "und".
# Keep the regional form while retaining the other as a matching alias.
PREFERRED_NAMES = {
    "Québec", "Nova Scotia", "Gulf of St. Lawrence", "Bay of Fundy", "Northumberland Strait",
    "Fleuve Saint-Laurent", "Baie des Chaleurs", "Cabot Strait", "Strait of Belle Isle",
}
TERMS = {
    "Gulf": "sea", "Harbour": "harbour", "Cove": "cove", "Strait": "strait",
    "Passage": "passage", "Bank": "bank", "Banks": "bank", "Ledge": "ledge", "Ledges": "ledge",
    "Shoal": "shoal", "Shoals": "shoal", "Reef": "shoal", "Reefs": "shoal",
    "Neighbourhood": "neighbourhood", "Neighborhood": "neighbourhood",
    "Hamlet": "hamlet", "Point": "point", "Head": "head",
}


def read_source(path):
    with zipfile.ZipFile(path) as archive:
        name, = (name for name in archive.namelist() if name.endswith(".csv"))
        with archive.open(name) as stream:
            yield from csv.DictReader(io.TextIOWrapper(stream, encoding="utf-8-sig", newline=""))


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--cache", type=Path, default=ROOT / ".local/cgn")
    args = parser.parse_args()
    args.cache.mkdir(parents=True, exist_ok=True)
    west, south, east, north = json.loads((ROOT / "web/region/config.json").read_text())["dataBounds"]
    groups = collections.defaultdict(list)
    hashes = {}
    counts = collections.Counter()
    excluded_terms = collections.Counter()
    for province in PROVINCES:
        file = f"cgn_{province}_csv_eng.zip"
        path = args.cache / file
        if not path.exists():
            with urllib.request.urlopen(BASE + file, timeout=90) as stream:
                payload = stream.read()
            temporary = path.with_suffix(".part")
            temporary.write_bytes(payload)
            temporary.replace(path)
        hashes[file] = hashlib.sha256(path.read_bytes()).hexdigest()
        for row in read_source(path):
            code = row["Concise Code"]
            if code not in CATEGORIES or not row["Latitude"] or not row["Longitude"]:
                continue
            lon, lat = float(row["Longitude"]), float(row["Latitude"])
            if not (west <= lon <= east and south <= lat <= north):
                continue
            name = row["Geographical Name"].strip()
            if not name:
                continue
            term = row["Generic Term"]
            category = row["Generic Category"]
            if term == "Metropolitan Community Territory" or (category == "Administrative Area" and code != "PROV"):
                excluded_terms[term] += 1
                continue
            kind = TERMS.get(term, CATEGORIES[code])
            if code == "UNP" and term in {"Borough", "Suburban Community", "Urban Community"}:
                kind = "neighbourhood"
            if code in {"GEOG", "MUN1", "MUN2"} and category == "Populated Place":
                kind = "town"
            scale = int(row["Relevance at Scale"] or 50000)
            coord = (round(lon, 5), round(lat, 5))
            identity = row["Toponymic Feature ID"] or row["CGNDB ID"]
            groups[identity, coord, kind].append((name, row["ISO Language Code"], scale, province))
            counts["eligible"] += 1
    points = []
    for (_, coord, kind), variants in groups.items():
        # Keep separate positions along long features. Prefer French in Québec,
        # including the official accented province name (both entries are und).
        preferred = any(province == "qc" for _, _, _, province in variants)
        by_language = "fra" if preferred else "eng"
        name, _, scale, _ = min(variants, key=lambda row: (
            row[0] not in PREFERRED_NAMES, row[1] != by_language,
            PROVINCES.index(row[3]) if not preferred else row[3] != "qc", -row[2], row[0],
        ))
        aliases = sorted({variant[0] for variant in variants} - {name})
        counts["alternate spellings"] += len(aliases)
        points.append([*coord, name, kind, scale, *aliases])
    points.sort()
    stats = {**counts, "points": len(points), "collapsed source rows": counts["eligible"] - len(points),
             "categories": dict(sorted(collections.Counter(point[3] for point in points).items())),
             "excluded administrative rows by term": dict(sorted(excluded_terms.items())),
             "sha256": hashes}
    payload = json.dumps(points, ensure_ascii=False, separators=(",", ":")).encode()
    (ROOT / "tools/gazetteer.json.gz").write_bytes(gzip.compress(payload, compresslevel=9, mtime=0))
    print(json.dumps(stats, indent=2, ensure_ascii=False))


if __name__ == "__main__":
    main()
