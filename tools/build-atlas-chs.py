#!/usr/bin/env python3
"""Build the CHS chart-mark snapshot from cached Maritime Chart Service identify responses."""
import argparse
from collections import defaultdict
from hashlib import sha256
import json
import math
from pathlib import Path
import re
import time
from urllib.error import HTTPError, URLError
from urllib.parse import urlencode
from urllib.request import Request, urlopen

ROOT = Path(__file__).resolve().parents[1]
BOUNDS = (-68.85, 42.99, -56.30, 47.58)  # web/map.mjs
ENDPOINT = ('https://egisp.dfo-mpo.gc.ca/arcgis/rest/services/chs/ENC_MaritimeChartService'
            '/MapServer/exts/MaritimeChartService/MapServer/identify')


class Identify:
    def __init__(self, cache, offline):
        self.cache = cache
        cache.mkdir(parents=True, exist_ok=True)
        self.offline = offline
        self.requests = 0
        self.max_records = 0

    def fetch(self, box, width, height):
        envelope = ','.join(f'{x:.8f}'.rstrip('0').rstrip('.') for x in box)
        url = ENDPOINT + '?' + urlencode(dict(
            geometry=envelope, geometryType='esriGeometryEnvelope', sr=4326,
            layers='all:6', tolerance=0, mapExtent=envelope,
            imageDisplay=f'{width},{height},96', returnGeometry='true', f='json'))
        digest = sha256(url.encode()).hexdigest()
        path = self.cache / (digest + '.json')
        if not path.exists():
            if self.offline:
                raise RuntimeError(f'Missing cached tile {box}, {width}x{height}')
            for attempt in range(2):
                if self.requests >= 1480:
                    raise RuntimeError('CHS request budget reached')
                time.sleep(1.05 if attempt == 0 else 20)
                self.requests += 1
                try:
                    with urlopen(Request(url, headers={'User-Agent': 'Atlas research client'}), timeout=45) as response:
                        body = response.read()
                    path.with_suffix('.part').write_bytes(body)
                    path.with_suffix('.part').replace(path)
                    break
                except (URLError, TimeoutError) as error:
                    if isinstance(error, HTTPError):
                        (self.cache / f'{digest}.http-{error.code}-{time.time_ns()}').write_bytes(error.read())
                        if error.code in {403, 429} or error.headers.get('Retry-After'):
                            raise RuntimeError(f'CHS server pushback: {error}') from error
                    if attempt:
                        raise
        data = json.loads(path.read_bytes())
        if 'results' not in data:
            raise RuntimeError(f'Unexpected CHS response for {box}: {data.get("error", data)}')
        self.max_records = max(self.max_records, len(data['results']))
        return data

    def tile(self, box, density, depth=0):
        west, south, east, north = box
        data = self.fetch(box, round((east - west) * density), round((north - south) * density))
        if len(data['results']) >= 800 or data.get('exceededTransferLimit'):
            if depth == 5:
                raise RuntimeError(f'Persistent transfer limit in {box}')
            for child in grid(box, 2, 2):
                yield from self.tile(child, density, depth + 1)
        else:
            yield from data['results']


def grid(box, columns, rows):
    west, south, east, north = box
    xs = [west + i * (east - west) / columns for i in range(columns + 1)]
    ys = [south + i * (north - south) / rows for i in range(rows + 1)]
    for bottom, top in zip(ys, ys[1:]):
        for left, right in zip(xs, xs[1:]):
            yield left, bottom, right, top


def harvest(identify):
    records = {}
    for index, box in enumerate(grid(BOUNDS, 15, 6), 1):
        # Sample two display scales. Broad empty tiles still get a detailed pass:
        # a coarse response cannot establish that there are no large-scale ENCs.
        coarse = list(identify.tile(box, 18000))
        fine = list(identify.tile(box, 36000))
        for record in coarse + fine:
            a = record['attributes']
            records[(a['cellName'], a['rcid'])] = record
        print(f'{index}/90 {len(coarse)}/{len(fine)} rows, {len(records)} distinct cell records', flush=True)
    return records.values()



COLORS = dict(white='W', black='B', red='R', green='G', blue='U', yellow='Y',
              grey='E', brown='N', amber='A', violet='V', orange='O', magenta='M', pink='P')
SHAPES = {'spar (spindle)': 'spar', 'conical (nun, ogival)': 'conical',
          'can (cylindrical)': 'can', 'stake, pole, perch, post': 'stake',
          'beacon tower': 'tower', 'lattice beacon': 'lattice', 'pile beacon': 'pile'}
PATTERNS = {'horizontal stripes': 'horizontal', 'vertical stripes': 'vertical',
            'diagonal stripes': 'diagonal', 'squared': 'squared', 'stripes (direction unknown)': 'striped',
            'border stripes': 'border'}
CHARACTERS = {'fixed': 'F', 'flashing': 'Fl', 'long-flashing': 'LFl', 'quick-flashing': 'Q',
              'very quick-flashing': 'VQ', 'ultra quick-flashing': 'UQ', 'isophase': 'Iso',
              'morse': 'Mo', 'occulting': 'Oc', 'quick-flash plus long-flash': 'Q+LFl',
              'very quick-flash plus long-flash': 'VQ+LFl', 'alternating (continuous)': 'Al'}


def colours(attributes):
    return [COLORS[c.strip()] for c in attributes.get('COLOUR', '').split(',') if c.strip() in COLORS]


def light_reference(info):
    match = re.fullmatch(r'ATL(\d+(?:\.\d+)?)', info, re.IGNORECASE)
    return match[1] if match else ''


def field(attributes, key):
    value = attributes.get(key, '').strip()
    return '' if value.lower() == 'unknown' else value


def coordinates(record):
    geometry = record['geometry']
    return geometry['x'], geometry['y']


def rank(record):
    a = record['attributes']
    return int(a['compilationScale']), a['cellName'], int(a['rcid'])


def distance(a, b):
    return 111195 * math.hypot((a[0] - b[0]) * math.cos(math.radians((a[1] + b[1]) / 2)),
                               a[1] - b[1])


def unique_marks(marks):
    by_id = {}
    by_position = defaultdict(list)
    by_name = defaultdict(list)
    by_reference = defaultdict(list)
    for record in sorted(marks, key=rank):
        a = record['attributes']
        xy = coordinates(record)
        identifier, name = field(a, 'LNAM'), field(a, 'OBJNAM').casefold()
        kind = a['objectType'][:3]
        reference = light_reference(field(a, 'INFORM'))
        canonical = by_id.get(identifier) if identifier else None
        if canonical is None and reference:
            canonical = next((other for other in by_reference[kind, reference]
                              if other['attributes']['cellName'] != a['cellName']
                              and distance(xy, coordinates(other)) <= 1000), None)
        if canonical is None:
            canonical = next((other for other in by_position[kind, xy]
                              if other['attributes']['cellName'] != a['cellName']
                              and (not name or not field(other['attributes'], 'OBJNAM')
                                   or field(other['attributes'], 'OBJNAM').casefold() == name)), None)
        if canonical is None and name:
            canonical = next((other for other in by_name[kind, name]
                              if other['attributes']['cellName'] != a['cellName']
                              and distance(xy, coordinates(other)) <= 100), None)
        if identifier:
            by_id[identifier] = canonical or record
        if canonical is None:
            by_position[kind, xy].append(record)
            if name:
                by_name[kind, name].append(record)
            if reference:
                by_reference[kind, reference].append(record)
            yield record


def signal(light):
    a = light['attributes']
    character = field(a, 'LITCHR')
    group = field(a, 'SIGGRP')
    if group.startswith('(') and group.endswith(')'):
        group = group[1:-1]
    colour = colours(a)
    period = field(a, 'SIGPER')
    return {key: value for key, value in dict(
        lc=colour[0] if colour else '', lcs='/'.join(colour),
        lch=CHARACTERS.get(character, character), lg=group,
        lp=float(period) if period else None).items() if value}


def build(records):
    points = [r for r in records if r['geometryType'] == 'esriGeometryPoint' and 'x' in r.get('geometry', {})]
    lights = defaultdict(list)
    light_refs = set()
    for record in points:
        a = record['attributes']
        if a['objectType'] == 'LIGHTS':
            lights[coordinates(record)].append(record)
            reference = light_reference(field(a, 'INFORM'))
            if reference:
                light_refs.add(reference)
    features = []
    for record in unique_marks(r for r in points if r['attributes']['objectType'].startswith(('BOY', 'BCN'))):
        a = record['attributes']
        x, y = xy = coordinates(record)
        if not (BOUNDS[0] <= x <= BOUNDS[2] and BOUNDS[1] <= y <= BOUNDS[3]):
            continue
        kind = 'buoy' if a['objectType'].startswith('BOY') else 'beacon'
        shape = field(a, 'BOYSHP' if kind == 'buoy' else 'BCNSHP')
        pattern = field(a, 'COLPAT')
        name = field(a, 'OBJNAM')
        category = next((field(a, key) for key in ('CATLAM', 'CATCAM', 'CATSPM', 'CATSAW') if field(a, key)),
                        a['objectTypeDescription'].partition(', ')[2])
        p = {key: value for key, value in dict(
            k=kind, n=name, s=SHAPES.get(shape, shape), cat=category,
            cs=''.join(colours(a)), pat=PATTERNS.get(pattern, pattern)).items() if value}
        if re.fullmatch(r'[A-Z]{0,5}\d{1,4}[A-Z]?', name):
            p['ref'] = name
        p['src'] = 'chs'
        if field(a, 'STATUS') == 'private':
            p['status'] = 'private'
        colocated = sorted(lights[xy], key=lambda r: (r['attributes']['cellName'] != a['cellName'], rank(r)))
        info = field(a, 'INFORM')
        if colocated:
            p['lit'] = 1
            primary = colocated[0]
            p.update(signal(primary))
            info = field(primary['attributes'], 'INFORM') or info
            # Retain distinct sector signals in the selected cell for the card.
            sectors = [signal(r) for r in colocated if r['attributes']['cellName'] == primary['attributes']['cellName']]
            additional = [value for i, value in enumerate(sectors) if value != sectors[0] and value not in sectors[:i]]
            if additional:
                p['signals'] = additional
        elif light_reference(info) not in light_refs and not re.search(r'\b(?:Lts?|lights?)\b', info, re.IGNORECASE):
            # An ATL number identifies an aid and is also assigned to unlit marks.
            p['lit'] = 0
        reference = light_reference(info)
        if reference:
            p['ll'] = reference
        features.append(dict(type='Feature', geometry=dict(type='Point', coordinates=[round(x, 7), round(y, 7)]),
                             properties=p))
    features.sort(key=lambda f: (f['geometry']['coordinates'], f['properties']['k'], f['properties'].get('n', '')))
    return dict(type='FeatureCollection', features=features)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--cache', type=Path, default=Path('/tmp/chs-marks'))
    parser.add_argument('--offline', action='store_true')
    parser.add_argument('--output', type=Path, default=ROOT / 'web/chs-marks.json')
    parser.add_argument('--inventory', type=Path, help='Save merged raw records for analysis')
    args = parser.parse_args()
    identify = Identify(args.cache, args.offline)
    records = list(harvest(identify))
    print(f'{identify.requests} new requests, largest response {identify.max_records} records')
    if args.inventory:
        args.inventory.write_text(json.dumps(records))
    args.output.write_text(json.dumps(build(records), ensure_ascii=False, separators=(',', ':')) + '\n')


if __name__ == '__main__':
    main()
