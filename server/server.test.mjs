import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { fileURLToPath } from "node:url";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { brotliCompressSync } from "node:zlib";
import test from "node:test";
import { retained, RETENTION_MS } from "./ais.mjs";
import { request } from "node:http";
import { createFeed } from "./ais-live.mjs";
import { parseBuoy } from "./buoys.mjs";
import { createApp } from "./server.mjs";

test("feed keeps vessels and reports live", () => {
  let socket;
  class Fake extends EventEmitter { constructor() { super(); socket = this; } send(m) { this.sent = JSON.parse(m); } terminate() {} }
  const feed = createFeed({ key: "mock", WebSocket: Fake, log: () => {} });
  feed.start();
  assert.equal(feed.snapshot().status, "waiting");
  socket.emit("open");
  assert.equal(socket.sent.APIKey, "mock");
  socket.emit("message", Buffer.from(JSON.stringify({ MessageType: "PositionReport", MetaData: { ShipName: "TEST" },
    Message: { PositionReport: { UserID: 316000001, Latitude: 44.6, Longitude: -63.5, Sog: 5, Cog: 90, Valid: true } } })));
  const snapshot = feed.snapshot();
  assert.equal(snapshot.status, "live");
  assert.equal(snapshot.points[0].name, "TEST");
  assert.ok(!("timestamp" in snapshot.points[0]));
  feed.stop();
});

test("server serves only the map and its two endpoints", async t => {
  const app = createApp({ root: fileURLToPath(new URL("../web", import.meta.url)), feed: null,
    buoyHandler: async () => ({ stations: [{ id: "x" }] }) });
  await new Promise(done => app.listen(0, "127.0.0.1", done));
  t.after(() => app.close());
  const base = `http://127.0.0.1:${app.address().port}`;
  assert.equal((await fetch(base + "/")).status, 200);
  assert.equal((await fetch(base + "/map.mjs")).headers.get("content-encoding"), "gzip");
  assert.equal((await (await fetch(base + "/api/ships")).json()).status, "not-configured");
  assert.equal((await fetch(base + "/api/buoys")).status, 200);
  for (const bad of ["/server/server.mjs", "/..%2fpackage.json", "/.env"]) assert.equal((await fetch(base + bad)).status, 404);
  assert.equal((await fetch(base + "/", { method: "POST" })).status, 405);
});

test("old reports expire and buoy files parse", () => {
  const now = Date.now();
  assert.equal(retained([{ timestamp: now }, { timestamp: now - RETENTION_MS - 1 }], now).length, 1);
  const reading = parseBuoy("#YY MM DD hh mm WDIR WSPD\n#yr mo dy hr mn degT m/s\n2026 11 25 12 00 270 5.0");
  assert.equal(reading.WDIR, 270);
});

test("old hostnames redirect and keep the path", async t => {
  const app = createApp({ root: fileURLToPath(new URL("../web", import.meta.url)), feed: null,
    redirects: { "old.example": "new.example" } });
  await new Promise(done => app.listen(0, "127.0.0.1", done));
  t.after(() => app.close());
  const ask = host => new Promise(done => request({ port: app.address().port, host: "127.0.0.1",
    path: "/map.mjs?x=1", headers: { host } }, res => { res.resume(); done(res); }).end());
  const moved = await ask("old.example");
  assert.equal(moved.statusCode, 301);
  assert.equal(moved.headers.location, "https://new.example/map.mjs?x=1");
  assert.equal((await ask("new.example")).statusCode, 200);
});

test("fog levels and the biggest ship in the harbour", async () => {
  const { fogFrom, biggestInHarbour } = await import("../web/atlas-extras.mjs");
  assert.equal(fogFrom({ visibility: 20000, weather_code: 0 }), 0);
  assert.ok(fogFrom({ visibility: 4000 }) < .2);
  assert.ok(fogFrom({ visibility: 900 }) > .4 && fogFrom({ visibility: 900 }) < .6);
  assert.equal(fogFrom({ visibility: 60 }), 1);
  assert.ok(fogFrom({ visibility: 20000, weather_code: 45 }) >= .45);
  const ship = (name, length, extra = {}) => ({ name, length, lat: 44.65, lon: -63.57, age: 30, ...extra });
  const best = biggestInHarbour([ship("small", 20), ship("big", 290), ship("far", 400, { lon: -61 }),
    ship("old", 350, { age: 9000 }), ship("unsized", undefined)]);
  assert.equal(best.name, "big");
});

test("cloud, rain, snow and moon readings", async () => {
  const { cloudFrom, precipitationFrom, moonlight } = await import("../web/atlas-extras.mjs");
  assert.equal(cloudFrom({}), null);
  assert.equal(cloudFrom({ cloud_cover: 100, cloud_cover_low: 100 }), 1);
  assert.equal(precipitationFrom({ weather_code: 3, precipitation: 0 }), null);
  assert.equal(precipitationFrom({ weather_code: 73 }).kind, "snow");
  assert.equal(precipitationFrom({ weather_code: 65 }).kind, "rain");
  const full = moonlight(Date.UTC(2026, 10, 24, 14, 53)/1000), dark = moonlight(Date.UTC(2026, 11, 9, 0, 52)/1000);
  assert.ok(full > .95 && dark < .05, `${full} ${dark}`);
});

test("ship dimensions are read from static reports", async () => {
  const { update } = await import("./ais.mjs");
  const vessels = new Map(), metadata = new Map(), seen = new Set();
  update({ MessageType: "ShipStaticData", MetaData: {}, Message: { ShipStaticData: { UserID: 1, Name: "X", Type: 70,
    Dimension: { A: 200, B: 94, C: 16, D: 16 } } } }, vessels, metadata, seen, 1);
  update({ MessageType: "PositionReport", MetaData: {}, Message: { PositionReport: { UserID: 1, Latitude: 44.6, Longitude: -63.5 } } },
    vessels, metadata, seen, 2);
  assert.equal(vessels.get(1).length, 294);
  assert.equal(vessels.get(1).width, 32);
});

const listen = async (t, app) => {
  await new Promise(done => app.listen(0, "127.0.0.1", done));
  t.after(() => app.close());
  return `http://127.0.0.1:${app.address().port}`;
};

test("precompressed files are negotiated, each with its own ETag", async t => {
  const root = mkdtempSync(join(tmpdir(), "atlas-"));
  t.after(() => rmSync(root, { recursive: true }));
  const text = "<p>chart</p>".repeat(50);
  writeFileSync(join(root, "index.html"), text);
  writeFileSync(join(root, "index.html.br"), brotliCompressSync(Buffer.from(text)));
  const base = await listen(t, createApp({ root, feed: null }));
  const get = headers => new Promise(done => request(base + "/", { headers }, res => { res.resume(); done(res); }).end());
  const br = await get({ "accept-encoding": "gzip, br" }), gz = await get({ "accept-encoding": "gzip, br;q=0" }),
    none = await get({});
  assert.equal(br.headers["content-encoding"], "br");
  assert.equal(gz.headers["content-encoding"], "gzip");
  assert.equal(none.headers["content-encoding"], undefined);
  assert.equal(new Set([br, gz, none].map(r => r.headers.etag)).size, 3);
  assert.equal((await get({ "accept-encoding": "br", "if-none-match": br.headers.etag })).statusCode, 304);
  assert.equal((await get({ "accept-encoding": "gzip", "if-none-match": br.headers.etag })).statusCode, 200);
  assert.equal((await fetch(base + "/index.html.br")).status, 404);
});

test("ship snapshots are shared for a second and buoy refreshes are shared", async t => {
  let snapshots = 0, calls = 0, fail = true;
  const base = await listen(t, createApp({ root: fileURLToPath(new URL("../web", import.meta.url)),
    feed: { snapshot: () => ({ status: "live", points: [], asOf: ++snapshots }) },
    buoyHandler: async () => { ++calls; await new Promise(r => setTimeout(r, 80)); return { stations: fail ? [] : [{ id: "x" }] }; } }));
  await Promise.all(Array.from({ length: 12 }, () => fetch(base + "/api/ships").then(r => r.json())));
  assert.equal(snapshots, 1);
  const cold = await Promise.all(Array.from({ length: 12 }, () => fetch(base + "/api/buoys")));
  assert.deepEqual([...new Set(cold.map(r => r.status))], [503]);
  assert.equal(calls, 1);
  assert.equal((await fetch(base + "/api/buoys")).status, 503);   // a failure is not retried at once
  assert.equal(calls, 1);
  fail = false;
  const later = Date.now() + 61_000;
  t.mock.method(Date, "now", () => later);
  const warm = await Promise.all(Array.from({ length: 12 }, () => fetch(base + "/api/buoys")));
  assert.deepEqual([...new Set(warm.map(r => r.status))], [200]);
  assert.equal(calls, 2);
});
