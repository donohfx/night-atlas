# Data terms (not MIT)

The MIT licence covers the original code only.

## Lighthouse data: non-commercial only

`web/chart-data.json`, its copy in the desktop plugin, and `tools/atlas-lighthouses.csv` / `tools/atlas-light-overrides.json` combine:

- positions and names from **OpenStreetMap** (© OpenStreetMap contributors, ODbL 1.0);
- signal details reconciled from the **Canadian Coast Guard** *List of Lights, Buoys and Fog Signals, Atlantic Coast*, with a few ranges or periods from NGA Pub. 110;
- a few hand-checked corrections, with their sources recorded in the overrides file.

Source: Canadian Coast Guard, Fisheries and Oceans Canada. This is an unofficial, modified reproduction, not made in affiliation with or endorsed by the Government of Canada. Accuracy is not guaranteed. The [Canada.ca terms](https://www.canada.ca/en/transparency/terms.html) allow non-commercial reproduction with attribution; commercial redistribution generally needs written permission. **Do not use these files commercially** without obtaining it. If you need unrestricted reuse, replace them with data built only from OpenStreetMap.

Combining these sources may not satisfy ODbL share-alike for the merged file. If you are a rights holder and want something changed or removed, please open an issue.

## NOTMAR navigation aid supplement

`web/aids.json` (and its copy in the desktop plugin) is an unofficial, modified extract of the Canadian Coast Guard
*List of Lights, Buoys and Fog Signals, Atlantic Coast*, via [NOTMAR](https://notmar.gc.ca/list-lights).
The same non-commercial terms and attribution above apply. It is a snapshot for
visualization and must never be used for navigation. Regenerate locally with
`python tools/build-atlas-aids.py` (BeautifulSoup and lxml required).

## Other data

See [CREDITS.md](CREDITS.md) for OpenStreetMap, NOAA, Open-Meteo, AIS Stream and the other sources.
