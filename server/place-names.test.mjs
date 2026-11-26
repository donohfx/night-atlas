import assert from "node:assert/strict";
import test from "node:test";
import {mergeNames, officialZoom, osmZoom} from "../web/place-names.mjs";

test("regional and larger names appear before local details", () => {
  assert.ok(officialZoom("region", 30e6) < officialZoom("city", 7.5e6));
  assert.ok(officialZoom("strait", 5e6) < officialZoom("cove", 50000));
  assert.ok(officialZoom("lake", 5e6) < officialZoom("lake", 50000));
  assert.ok(officialZoom("town", 1e6) < officialZoom("neighbourhood", 1e6));
  assert.ok(osmZoom("city", 4) < osmZoom("city", 12));
  assert.ok(osmZoom("lake", 1) < osmZoom("lake", 7));
});

const place = (source, name, kind, lon, lat, zoom, aliases) => ({source,name,kind,lon,lat,zoom,aliases});

test("official local spelling wins and preserves the earlier OSM display tier", () => {
  const official = place("official", "Québec", "city", -71.207, 46.814, 8);
  const osm = place("osm", "Quebec City", "city", -71.21, 46.81, 6, ["Quebec", "Québec"]);
  const result = mergeNames([official], [osm]);
  assert.equal(result.counts.crossSource, 1);
  assert.deepEqual(result.points.map(p => [p.name,p.zoom,p.lon]), [["Québec",6,osm.lon]]);
  assert.equal(official.zoom, 8);
});

test("translated hydrographic generics and explicit bilingual aliases deduplicate nearby", () => {
  const official = [
    place("official", "Rivière de la Paix", "river", -71.2, 46.8, 10),
    place("official", "Fleuve Saint-Laurent", "river", -72.1, 47, 8, ["St. Lawrence River"]),
  ];
  const osm = [
    place("osm", "La Paix River", "river", -71.21, 46.8, 10),
    place("osm", "St Lawrence River", "river", -72.15, 47, 8),
  ];
  const result = mergeNames(official, osm);
  assert.equal(result.counts.crossSource, 2);
  assert.deepEqual(result.points.map(p => p.name), official.map(p => p.name));
});

test("nearby homonyms in different categories and distant namesakes stay separate", () => {
  const official = [
    place("official", "Kingston", "city", -76.5, 44.2, 7),
    place("official", "Kingston", "town", -65.9, 45.5, 10),
    place("official", "The Narrows", "channel", -63.6, 44.66, 13),
    place("official", "The Narrows", "channel", -63.6, 44.68, 13),
  ];
  const osm = [
    place("osm", "Kingston", "bay", -76.5, 44.2, 10),
    place("osm", "Kingston", "town", -68.5, 44.2, 10),
    place("osm", "Kingston", "town", -68.5, 44.2, 10),
  ];
  const result = mergeNames(official, osm);
  assert.deepEqual(result.counts, {official:0,crossSource:0,osm:1});
  assert.equal(result.points.length, 6);
});

test("a settlement label on the island of the same name draws once", () => {
  const official = place("official", "McNabs Island", "island", -63.51944, 44.61031, 9);
  const osm = place("osm", "McNabs Island", "hamlet", -63.5373, 44.61963, 11);
  const result = mergeNames([official], [osm]);
  assert.equal(result.counts.crossSource, 1);
  assert.deepEqual(result.points, [official]);
});

test("nearby seabed records with the same name and different descriptors draw once", () => {
  const shoal = place("official", "Barse Ground", "shoal", -63.56266, 44.41561, 13);
  const undersea = place("official", "Barse Ground", "undersea", -63.55946, 44.39903, 13);
  const result = mergeNames([shoal, undersea], []);
  assert.equal(result.counts.official, 1);
  assert.deepEqual(result.points, [shoal]);
});
