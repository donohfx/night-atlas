import {readFileSync} from "node:fs";
import {gunzipSync, gzipSync} from "node:zlib";
import {mercator} from "../web/atlas-shore.mjs";
import {officialZoom} from "../web/place-names.mjs";
import {zxyToTileId} from "../web/vendor/pmtiles.mjs";
import {writeArchive} from "./write-pmtiles.mjs";

export const gazetteerMinZoom = 5;
export const gazetteerMaxZoom = 12;

export function buildGazetteer(path, bounds) {
  const input = new URL("./gazetteer.json.gz", import.meta.url);
  const rows = JSON.parse(gunzipSync(readFileSync(input)));
  writeArchive(path, {bounds, minzoom:gazetteerMinZoom, maxzoom:gazetteerMaxZoom, type:0, compression:2,
    metadata:{name:"CGNDB", description:"Canadian Geographical Names Data Base, Natural Resources Canada"}}, add => {
    for (let z = gazetteerMinZoom; z <= gazetteerMaxZoom; z++) {
      const n = 2**z, tiles = new Map();
      for (const row of rows) {
        const [lon, lat, name, kind, scale] = row;
        if (z < gazetteerMaxZoom && officialZoom(kind, scale, name) > z) continue;
        const [x,y] = mercator([lon,lat]);
        const id = zxyToTileId(z, Math.floor(x*n), Math.floor(y*n));
        if (!tiles.has(id)) tiles.set(id, []);
        tiles.get(id).push(row);
      }
      for (const [id, contents] of tiles) add(id, gzipSync(JSON.stringify(contents)));
    }
  });
}
