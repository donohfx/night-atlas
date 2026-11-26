"""Filter a saved CHS harvest and reconcile the regional Coast Guard supplement."""
import argparse
from collections import defaultdict
from importlib import import_module
import json
from pathlib import Path

matcher = import_module("build-atlas-buoy-matches")
web = Path(__file__).resolve().parents[1] / "web"
region = web / "region"

def load(path):
    return json.loads(path.read_text())

def save(name, data):
    (region / name).write_text(json.dumps(data, ensure_ascii=False, separators=(",", ":")) + "\n")

def coords(mark):
    return tuple(mark["geometry"]["coordinates"])

def properties(mark):
    return mark["properties"]

def mark_key(mark):
    return properties(mark)["k"], properties(mark).get("n", "").casefold()

parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument("harvest", type=Path)
args = parser.parse_args()
west, south, east, north = load(region / "config.json")["dataBounds"]
incoming = [f for f in load(args.harvest)["features"]
            if west <= coords(f)[0] <= east and south <= coords(f)[1] <= north]
baseline = load(web / "chs-marks.json")["features"]
by_position, by_name, by_number = defaultdict(list), defaultdict(list), defaultdict(list)
for mark in baseline:
    kind, name = mark_key(mark)
    by_position[kind, coords(mark)].append(name)
    if name:
        by_name[kind, name].append(mark)
    if number := properties(mark).get("ll"):
        by_number[kind, number].append(mark)

def represented(mark):
    kind, name = mark_key(mark)
    existing = by_position[kind, coords(mark)]
    if existing and (not name or "" in existing or name in existing):
        return True
    if name and any(matcher.meters(mark, old) <= 100 for old in by_name[kind, name]):
        return True
    number = properties(mark).get("ll")
    return bool(number and any(matcher.meters(mark, old) <= 1000 for old in by_number[kind, number]))

# Keep the existing marks and their exact coordinates, which also key the
# checked NS signal corrections. A partial harvest must never erase them.
additional = [mark for mark in incoming if not represented(mark)]
marks = [*baseline, *additional]
save("chs-marks.json", {"type": "FeatureCollection", "features": marks})
print(f"{len(incoming)} snapshot marks inside coverage; {len(baseline)} retained, {len(additional)} added")

old_matches = load(web / "ccg-buoy-matches.json")
old_numbers = {properties(f)["ll"] for f in matcher.buoys(web / "aids.json")}
regional_buoys = [f for f in matcher.buoys(region / "aids.json") if properties(f)["ll"] not in old_numbers]
new_matches = matcher.build([f for f in marks if properties(f)["k"] == "buoy"], regional_buoys)
old_override_keys = {(tuple(o["coordinates"]), o["name"]) for o in old_matches["overrides"]}
save("ccg-buoy-matches.json", {
    "fillIns": [*old_matches["fillIns"], *new_matches["fillIns"]],
    "overrides": [*old_matches["overrides"], *(o for o in new_matches["overrides"]
                   if (tuple(o["coordinates"]), o["name"]) not in old_override_keys)],
})
