import assert from "node:assert/strict";
import {readFileSync} from "node:fs";
import {test} from "node:test";
import {decodeReach, encodeReach, lightKey, reachRevision, validatedReachTables} from "../web/atlas-reach-table.mjs";
import {STEPS, MAX_REACH_STEP, METRES_PER_REACH_STEP} from "../web/atlas-shore.mjs";

test("beam reach encodes all possible distances exactly and rejects invalid rows", () => {
  for (const offset of [0, MAX_REACH_STEP + 1 - STEPS]) {
    const reach = Float32Array.from({length:STEPS}, (_, i) => (i + offset) * METRES_PER_REACH_STEP);
    assert.deepEqual(decodeReach(encodeReach(reach)), reach);
  }
  assert.equal(decodeReach(undefined), null);
  assert.equal(decodeReach("AAAA"), null);
  assert.equal(decodeReach("!".repeat(STEPS * 8 / 3)), null);
  assert.equal(decodeReach("/".repeat(STEPS * 8 / 3)), null);
});

test("committed reach covers every potential sweep and rejects stale data", async () => {
  const read = name => readFileSync(new URL(`../web/${name}.json`, import.meta.url), "utf8");
  const [combined, open] = ["chart-data", "open-lights"].map(name => JSON.parse(read(name)).lights);
  const table = JSON.parse(read("beam-reach"));
  const shoreline = await reachRevision(read("land"));
  const valid = await validatedReachTables(table, shoreline, combined, open);
  for (const [mode, lights] of Object.entries({combined, open})) {
    const eligible = lights.filter(light => light.colors.length);
    assert.equal(Object.keys(valid[mode]).length, eligible.length);
    for (const light of eligible) assert.equal(decodeReach(valid[mode][lightKey(light)])?.length, STEPS);
  }

  assert.deepEqual(await validatedReachTables(table, "changed", combined, open), {});
  assert.deepEqual(await validatedReachTables({...table, format:0}, shoreline, combined, open), {});
  const changed = [{...combined[0], coordinates:[0, 0]}, ...combined.slice(1)];
  assert.deepEqual(await validatedReachTables(table, shoreline, changed, open), {open:valid.open});
  assert.notEqual(lightKey(changed[0]), lightKey(combined[0]));
});
