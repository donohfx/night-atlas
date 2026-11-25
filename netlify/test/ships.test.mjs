import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";
import { createHandler } from "../functions/ships.mjs";
import { collect, RETENTION_MS } from "../lib/ais.mjs";

const request = new Request("https://example.invalid/api/ships");

function fakeStore() {
  let entry = null;
  let version = 0;
  return {
    async getWithMetadata() {
      return structuredClone(entry);
    },
    async setJSON(_key, data, options) {
      if ((options.onlyIfNew && entry) || (options.onlyIfMatch && options.onlyIfMatch !== entry?.etag)) {
        return { modified: false };
      }
      const etag = String(++version);
      entry = { data: structuredClone(data), etag };
      return { modified: true, etag };
    },
  };
}

test("the unconfigured endpoint skips storage and the stream", async () => {
  const handler = createHandler({ env: {}, openStore: () => assert.fail("unexpected storage call") });
  const response = await handler(request);
  assert.equal((await response.json()).status, "not-configured");
  assert.match(response.headers.get("Netlify-CDN-Cache-Control"), /durable/);
});

test("misses and stale reads return immediately while one collector owns the lease", async () => {
  let now = Date.UTC(2026, 0, 1);
  let calls = 0;
  let finish;
  const jobs = [];
  const store = fakeStore();
  const context = { waitUntil: job => jobs.push(job) };
  const handler = createHandler({
    env: { AISSTREAM_API_KEY: "mock", AIS_SNAPSHOT_TTL_SECONDS: "60" },
    openStore: () => store,
    now: () => now,
    collectSnapshot: () => {
      calls++;
      return new Promise(resolve => { finish = resolve; });
    },
  });
  const first = await Promise.all([handler(request, context), handler(request, context)]);
  const firstBodies = await Promise.all(first.map(response => response.json()));
  assert.deepEqual(firstBodies.map(response => response.status), ["waiting", "waiting"]);
  assert.equal(calls, 1);
  now += 18_000;
  finish({ healthy: true, received: 1, points: [{ mmsi: 123, lat: 45, lon: -63, timestamp: now }] });
  await Promise.all(jobs);

  const fresh = await handler(request, context);
  assert.deepEqual((await fresh.json()).points, [{ mmsi: 123, lat: 45, lon: -63, age: 0 }]);
  assert.match(fresh.headers.get("Netlify-CDN-Cache-Control"), /max-age=60/);
  assert.equal(calls, 1);

  now += 61_000;
  const stale = await (await handler(request, context)).json();
  assert.equal(stale.status, "stale");
  assert.equal(stale.points[0].age, 61);
  assert.equal(calls, 2);
  finish({ healthy: false, received: 0, points: [{ mmsi: 123, lat: 45, lon: -63, timestamp: now - 61_000 }] });
  await Promise.all(jobs);
  const offline = await (await handler(request, context)).json();
  assert.equal(offline.status, "offline");
  assert.equal(offline.points[0].age, 61);
  assert.equal(calls, 2);
});

test("the stream normalizes binary reports, merges metadata and expires old points", async () => {
  const time = Date.UTC(2026, 0, 1);
  let closed = false;
  function position(mmsi, lon, kind = "PositionReport") {
    return {
      MessageType: kind,
      MetaData: { longitude: lon, latitude: 45.123456789 },
      Message: { [kind]: { UserID: mmsi, Valid: true, Sog: 102.3, Cog: 30, TrueHeading: 511 } },
    };
  }
  class MockSocket extends EventEmitter {
    constructor(url, options) {
      super();
      assert.equal(url, "wss://stream.aisstream.io/v0/stream");
      assert.equal(options.perMessageDeflate, true);
      queueMicrotask(() => this.emit("open"));
    }

    send(payload) {
      const subscription = JSON.parse(payload);
      assert.equal(subscription.APIKey, "mock");
      assert.deepEqual(subscription.BoundingBoxes, [[[47.63, -69.14], [42.83, -58.38]]]);
      assert.ok(subscription.FilterMessageTypes.includes("StandardClassBPositionReport"));
      const reports = [
        { MessageType: "SubscriptionConfirmation" },
        { MessageType: "ShipStaticData", Message: {
          ShipStaticData: { UserID: 123, Name: "  TEST @", Destination: "PORT", Type: 80 },
        } },
        position(123, -63, "StandardClassBPositionReport"),
        position(456, -70),
      ];
      for (const event of reports) this.emit("message", Buffer.from(JSON.stringify(event)));
    }

    terminate() {
      closed = true;
    }
  }
  const result = await collect("mock", [
    { mmsi: 456, timestamp: time - 1000 },
    { mmsi: 789, timestamp: time - RETENTION_MS },
  ], MockSocket, () => time, 10);
  assert.equal(closed, true);
  assert.equal(result.healthy, true);
  assert.equal(result.received, 1);
  assert.deepEqual(result.points, [{
    mmsi: 123, name: "TEST", destination: "PORT", type: 80,
    lat: 45.12346, lon: -63, speed: null, course: 30, heading: null, timestamp: time,
  }]);
});
