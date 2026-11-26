import assert from "node:assert/strict";
import {createHash} from "node:crypto";
import {readFileSync} from "node:fs";
import {test} from "node:test";
import {isPrivateWarning, markBuilder, nearestMark, privateWarningTitle} from "../web/atlas-marks.mjs";

const [osm, aids, chs, matches] = ["seamarks", "aids", "chs-marks", "ccg-buoy-matches"]
  .map(name => JSON.parse(readFileSync(new URL(`../web/${name}.json`, import.meta.url))));

for (const [label, chart, combinedHash, openHash] of [
  // Serialized features from the pre-index matcher, including IDs, order and every property.
  ["CHS available", chs,
    "2a76685b3793471095c14c8d1393ca26f7b70083ae897ed20e91f86b52af6288",
    "8b63726b048b247e55d95d6576a18017f78710961ad4dcf28de2ca448abaa556"],
  ["CHS unavailable", {features:[]},
    "6edf017123869e9fac387111fb7141f741a4ba03a397cb380f9062f67733d6e7",
    "fcb9c533af1bf09c1f27dacf7f0e8b5951d85ffa77803db68932ae78b633573a"],
]) {
  test(`marks preserve the legacy output with ${label}`, () => {
    for (const initialOpen of [false, true]) {
      const marksFor = markBuilder(osm, aids, chart, matches);
      const first = marksFor(initialOpen);
      const second = marksFor(!initialOpen);
      for (const [open, features] of [[initialOpen, first], [!initialOpen, second]]) {
        const expectedStatuses = chart.features.filter(f => f.properties.status === "private").length;
        assert.equal(features.filter(f => f.properties.status === "private").length, expectedStatuses);
        const hash = createHash("sha256").update(JSON.stringify(features,
          (key, value) => key === "status" && value === "private" ? undefined : value)).digest("hex");
        assert.equal(hash, open ? openHash : combinedHash);
        assert.equal(marksFor(open), features);
      }
    }
  });
}

test("private CHS warning beacons keep their names and yield to buoy hits", () => {
  const properties = {src:"chs", k:"beacon", cat:"general warning mark", status:"private", lit:1};
  assert.ok(isPrivateWarning(properties));
  for (const change of [{src:"osm"}, {k:"buoy"}, {cat:"leading mark"}, {status:undefined}]) {
    assert.ok(!isPrivateWarning({...properties, ...change}));
  }
  assert.equal(privateWarningTitle(properties), "Private warning light");
  assert.equal(privateWarningTitle({...properties, lit:0}), "Private warning mark");
  assert.equal(privateWarningTitle({...properties, n:"Example Point"}), "Example Point");
  const warning = {feature:{properties}, distance:0};
  const buoy = {feature:{properties:{k:"buoy"}}, distance:4};
  const beacon = {feature:{properties:{k:"beacon"}}, distance:2};
  assert.equal(nearestMark([warning, beacon]), warning.feature);
  assert.equal(nearestMark([buoy, warning]), buoy.feature);
  assert.equal(nearestMark([warning, buoy, beacon]), beacon.feature);
});
