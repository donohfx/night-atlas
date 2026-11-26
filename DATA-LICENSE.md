# Data terms (not MIT)

The MIT licence covers the original code only.

## Lighthouse data: non-commercial only

`web/chart-data.json`, its copy in the desktop plugin, and `tools/atlas-lighthouses.csv` / `tools/atlas-light-overrides.json` combine:

- positions and names from **OpenStreetMap** (© OpenStreetMap contributors, ODbL 1.0);
- signal details reconciled from the **Canadian Coast Guard** *List of Lights, Buoys and Fog Signals, Atlantic Coast*, with a few ranges or periods from NGA Pub. 110;
- a few hand-checked corrections, with their sources recorded in the overrides file.

Source: Canadian Coast Guard, Fisheries and Oceans Canada. This is an unofficial, modified reproduction, not made in affiliation with or endorsed by the Government of Canada. Accuracy is not guaranteed. The [Canada.ca terms](https://www.canada.ca/en/transparency/terms.html) allow non-commercial reproduction with attribution; commercial redistribution generally needs written permission. **Do not use these files commercially** without obtaining it. If you need unrestricted reuse, replace them with data built only from OpenStreetMap.

Combining these sources may not satisfy ODbL share-alike for the merged file. If you are a rights holder and want something changed or removed, please open an issue.

The web-only `web/region/lights.json` pairs an OSM lighthouse inventory with
positions and signals from the Canadian Coast Guard *List of Lights, Buoys and
Fog Signals*. The same non-commercial terms apply to that layer and the
`tools/provinces/*.ccg.json` source extracts. The independent
`tools/provinces/*.osm.json` extracts are © OpenStreetMap contributors,
[ODbL 1.0](https://opendatacommons.org/licenses/odbl/1-0/). The web chart
uses the provincial layer only in combined mode.

## NOTMAR navigation aid supplement

`web/aids.json` (and its copy in the desktop plugin) is an unofficial, modified extract of the Canadian Coast Guard
*List of Lights, Buoys and Fog Signals, Atlantic Coast*, via [NOTMAR](https://notmar.gc.ca/list-lights).
`web/region/aids.json` is drawn from the same Atlantic Coast volume and the
Canadian Coast Guard's *List of Lights, Buoys and Fog Signals, Newfoundland and
Labrador Coast*, and the Nunatsiavut section of the Canadian Coast Guard's
*List of Lights, Buoys and Fog Signals, Arctic Coast*. The same non-commercial terms and attribution above apply. It is a snapshot for
visualization and must never be used for navigation. Regenerate locally with
`python tools/build-atlas-aids.py` (BeautifulSoup and lxml required).

## Canadian Hydrographic Service chart marks

`web/chs-marks.json`, its desktop copy, and the expanded `web/region/chs-marks.json` contain adapted buoy and beacon records from the
[CHS ENC Maritime Chart Service](https://open.canada.ca/data/en/dataset/12b769c8-48b8-4562-80fb-4a2e5ee9b45b), Fisheries and Oceans Canada.
[Contains information licensed under the Open Government Licence – Canada.](https://open.canada.ca/en/open-government-licence-canada/)
This snapshot is for visualization and must never be used for navigation.
Regenerate with `python tools/build-atlas-chs.py`, or add `--offline` to use the cached responses.

## Other data

See [CREDITS.md](CREDITS.md) for OpenStreetMap, NOAA, Open-Meteo, AIS Stream and the other sources.

## Open sources only

The Layers switch selects `open-lights.json` and excludes the CCG fill-ins, signal overrides,
and supplemental lights from the rendered map. The open lighthouse variant uses CHS or OSM
for each signal. It retains the original station inventory for independently unlocated,
unrecorded stations. Its `source` and `positionSource` fields identify those inputs separately.
Open mode disables the combined lighthouse sweep configuration. The combined chart remains
the default and retains the non-commercial terms above.

To remove the restricted sources from a future build, initialize both clients in open mode
and remove the switch back to combined mode. Replace the `lights` array of each
`chart-data.json` with the `open-lights.json` array, retaining `reliefBounds`. Remove the
`aids.json` and `ccg-buoy-matches.json` files, their fetches and desktop asset routes, and the
Coast Guard credits. Remove the web `sweeps.json` and the desktop sweep-override loading
and keep sweeping disabled. Any published repository that must exclude the original non-commercial
artifacts will also need to account for its historical copies and mixed-source builder inputs.
