#!/usr/bin/env python3
"""Match CHS buoys to the Coast Guard snapshot and write the combined-mode index."""
import json
import math
from pathlib import Path
import re

WEB = Path(__file__).resolve().parents[1] / 'web'


def properties(feature):
    return feature['properties']


def identifier(feature):
    p = properties(feature)
    return re.sub(r'[^A-Z0-9]', '', (p.get('ref') or p.get('n', '')).upper())


def meters(first, second):
    x, y = first['geometry']['coordinates']
    ox, oy = second['geometry']['coordinates']
    return 111195 * math.hypot((x - ox) * math.cos(math.radians((y + oy) / 2)), y - oy)


def match_priority(chs, ccg, distance):
    a, b = properties(chs), properties(ccg)
    name, ref = identifier(chs), identifier(ccg)
    if a.get('ll') and a['ll'] == b.get('ll') and distance <= 1000:
        return 0
    if name and name == ref and distance <= 250:
        return 1
    same_band = a.get('cs') and a.get('cs') == b.get('cs')
    if name and name == ref and same_band and distance <= 500:
        return 2
    # Proximity alone is weak evidence in a channel with densely spaced marks.
    if distance <= 30 and not (name and b.get("ref") and name != ref):
        if not a.get('cs') or not b.get('cs') or a['cs'][0] == b['cs'][0]:
            return 3
    if distance <= 8 and same_band and a.get('s') == b.get('s'):
        return 4
    return None


def buoys(path):
    return [f for f in json.loads(path.read_text())['features'] if properties(f)['k'] == 'buoy']


def build(chs, ccg):
    candidates = []
    nearby = set()
    for i, official in enumerate(ccg):
        x, y = official['geometry']['coordinates']
        for j, chart in enumerate(chs):
            ox, oy = chart['geometry']['coordinates']
            if abs(y - oy) > .01 or abs(x - ox) > .014:
                continue
            distance = meters(official, chart)
            if distance <= 500:
                nearby.add(i)
            rank = match_priority(chart, official, distance)
            if rank is not None:
                candidates.append((rank, distance, i, j))

    used_ccg, used_chs, overrides, methods = set(), set(), [], {}
    for rank, _, i, j in sorted(candidates):
        if i in used_ccg or j in used_chs:
            continue
        used_ccg.add(i)
        used_chs.add(j)
        methods[rank] = methods.get(rank, 0) + 1
        signal = properties(ccg[i])
        if properties(chs[j]).get('lit') == 0 and signal.get('lit') == 1:
            overrides.append({'coordinates': chs[j]['geometry']['coordinates'],
                              'name': properties(chs[j]).get('n', ''), 'ccg': signal['ll']})

    fill = [properties(f)['ll'] for i, f in enumerate(ccg) if i not in used_ccg]
    print(f'{len(used_ccg)} matched {methods}, {len(fill)} fill-ins '
          f'({len(nearby - used_ccg)} within 500 m), {len(overrides)} lit overrides')
    return {'fillIns': fill, 'overrides': overrides}


if __name__ == '__main__':
    result = build(buoys(WEB / 'chs-marks.json'), buoys(WEB / 'aids.json'))
    (WEB / 'ccg-buoy-matches.json').write_text(json.dumps(result, separators=(',', ':')) + '\n')
