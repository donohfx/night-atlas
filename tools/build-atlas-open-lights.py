#!/usr/bin/env python3
"""Build open lighthouse signals from an Overpass export and cached CHS identify rows."""
import argparse
import csv
import json
from pathlib import Path
import re
import runpy
from urllib.parse import urlencode
from urllib.request import Request, urlopen

TOOLS = Path(__file__).resolve().parent
WEB = TOOLS.parent / 'web'
CHS = runpy.run_path(str(TOOLS / 'build-atlas-chs.py'))
COLOURS = CHS['COLORS']
RESTRICTED = re.compile(r'coast guard|notmar|list of lights|garde côtière|\bccg\b', re.I)
STATION_TYPES = {'light_major', 'light_minor'}


def name_key(name):
    name = re.sub(r'\([^)]*\)', '', name.lower())
    return re.sub(r'[^a-z0-9]', '', re.sub('lighthouse|lightstation|range|light|harbour|harbor', '', name))


def number(value):
    return float(value) if re.fullmatch(r'\d+(?:\.\d+)?', str(value).strip()) else 0


def osm_position(obj):
    p = obj.get('center', obj)
    return (p['lon'], p['lat']) if 'lon' in p and 'lat' in p else None


def osm_signal(obj):
    tags = obj['tags']
    if any(RESTRICTED.search(value) for key, value in tags.items()
           if 'source' in key and ('seamark' in key or key == 'source')):
        return None
    for prefix in ('seamark:light:', 'seamark:light:1:'):
        character = tags.get(prefix + 'character', '').strip()
        colours = [COLOURS[c.strip()] for c in tags.get(prefix + 'colour', '').split(';') if c.strip() in COLOURS]
        if character and colours:
            return dict(character=character, colors=colours, period=number(tags.get(prefix + 'period')),
                        group=tags.get(prefix + 'group', '').strip('()'), range=number(tags.get(prefix + 'range')))
    return None


def chs_signal(record):
    a = record['attributes']
    p = CHS['signal'](record)
    if not p.get('lch') or not p.get('lc'):
        return None
    return dict(character=p['lch'], colors=p['lcs'].split('/'), period=p.get('lp', 0),
                group=p.get('lg', ''), range=number(a.get('VALNMR')))


def download_osm(path):
    box = '42.95,-68.90,47.63,-56.25'
    query = ('[out:json][timeout:35];('
             f'nwr["man_made"="lighthouse"]({box});'
             f'nwr["seamark:type"~"^light_(major|minor)$"]({box});'
             f'nwr["seamark:light:character"]({box});'
             f'nwr["seamark:light:1:character"]({box}););out center;')
    url = 'https://overpass-api.de/api/interpreter?' + urlencode({'data': query})
    request = Request(url, headers={'User-Agent': 'Atlas research client'})
    with urlopen(request, timeout=60) as response:
        body = response.read()
    data = json.loads(body)
    if data.get('remark') or not data.get('elements'):
        raise RuntimeError('Overpass returned an incomplete or empty export')
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_bytes(body)


def build(stations, inventory, osm, chs):
    distance = CHS['distance']
    coords = CHS['coordinates']
    by_osm_id = {f'{o["type"]}/{o["id"]}': o for o in osm if osm_position(o)}
    osm_objects = [o for o in by_osm_id.values() if o.get('tags')]
    # A floating light is not an alternative signal for a nearby fixed station.
    buoy_locations = {coords(r) for r in chs if r['attributes']['objectType'].startswith('BOY')}
    enc_lights = [r for r in chs if r['attributes']['objectType'] == 'LIGHTS'
                  and coords(r) not in buoy_locations
                  and 'air obstruction' not in r['attributes'].get('CATLIT', '')]

    result = []
    for station in stations:
        name, original = station['name'], station['coordinates']
        row = inventory.get(name, {})
        key = name_key(name)
        historic = bool(re.search(r'historic|museum|former', name, re.I))
        preferred = by_osm_id.get(row.get('osm_ref'))
        osm_candidates = []
        for obj in osm_objects:
            tags = obj['tags']
            d = distance(original, osm_position(obj))
            named = key in {name_key(tags.get(field, '')) for field in ('name', 'seamark:name')} and bool(key)
            fixed = tags.get('man_made') == 'lighthouse' or tags.get('seamark:type') in STATION_TYPES
            if obj == preferred or fixed and (named and d <= 500 or d <= 20):
                osm_candidates.append((obj != preferred, not named, d, obj))
        osm_candidates.sort(key=lambda entry: entry[:3])
        station_osm = osm_candidates[0][3] if osm_candidates else None

        enc = []
        if not historic:
            anchor = osm_position(station_osm) if station_osm else original
            for record in enc_lights:
                d = distance(anchor, coords(record))
                named = key and key == name_key(record['attributes'].get('OBJNAM', ''))
                if named and d <= 150 or d <= 25:
                    enc.append((not bool(named), d, CHS['rank'](record), record))
            enc.sort(key=lambda entry: entry[:3])
        station_enc = enc[0][3] if enc else None

        if station_osm:
            position, position_source = osm_position(station_osm), 'OpenStreetMap'
        elif station_enc:
            position, position_source = coords(station_enc), 'Canadian Hydrographic Service'
        elif row and not row.get('ccg_id') and 'latitude' in row:
            # The station inventory supplies positions for historic or unmapped structures.
            position, position_source = (float(row['longitude']), float(row['latitude'])), 'Station inventory'
        else:
            print(f'No independent position: {name}')
            continue

        signal = chs_signal(station_enc) if station_enc else None
        source = 'Canadian Hydrographic Service' if signal else position_source
        if not signal and station_osm:
            signal = osm_signal(station_osm)
            if signal:
                source = 'OpenStreetMap'
        defaults = dict(colors=[], character='', period=0, group='', range=0, sequence=[])
        result.append(dict(name=name, coordinates=position, positionSource=position_source,
                           source=source, **(defaults | (signal or {}))))
    return result


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--osm', type=Path, default=Path('/tmp/open-flag/osm-lights.json'))
    parser.add_argument('--osm-extra', type=Path, action='append', default=[])
    parser.add_argument('--chs', type=Path, default=Path('/tmp/chs-marks/inventory.json'))
    parser.add_argument('--output', type=Path, default=WEB / 'open-lights.json')
    args = parser.parse_args()
    if not args.osm.exists():
        download_osm(args.osm)
    osm = {}
    for path in [*args.osm_extra, args.osm]:
        for item in json.loads(path.read_text())['elements']:
            osm[item['type'], item['id']] = item
    with (TOOLS / 'atlas-lighthouses.csv').open() as source:
        inventory = {row['name']: row for row in csv.DictReader(source)}
    # The combined file selects station identities and provides lookup anchors only.
    stations = [{'name': entry['name'], 'coordinates': entry['coordinates']}
                for entry in json.loads((WEB / 'chart-data.json').read_text())['lights']]
    chs = [r for r in json.loads(args.chs.read_text()) if r.get('geometryType') == 'esriGeometryPoint'
           and 'x' in r.get('geometry', {})]
    lights = build(stations, inventory, osm.values(), chs)
    args.output.write_text(json.dumps({'lights': lights}, ensure_ascii=False, separators=(',', ':')) + '\n')
    print(f'{len(lights)} stations, {sum(bool(light["character"]) for light in lights)} signals')


if __name__ == '__main__':
    main()
