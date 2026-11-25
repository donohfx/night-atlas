import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { fileURLToPath } from "node:url";
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
