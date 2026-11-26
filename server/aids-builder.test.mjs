import assert from "node:assert/strict";
import {readFileSync} from "node:fs";
import {test} from "node:test";

test("light numbers are unique across List of Lights volumes", () => {
  const read = name => JSON.parse(readFileSync(new URL("../web/"+name, import.meta.url))).features;
  const numbers = read("aids.json").map(f => f.properties.ll);
  assert.equal(new Set(numbers).size, numbers.length);
});
