import { getStore } from "@netlify/blobs";
import WebSocket from "ws";
import { collect, REGION, retained } from "../lib/ais.mjs";

const BLOB_KEY = "snapshot";
const LEASE_MS = 65_000;
const INITIAL = { points: [], received: 0, updatedAt: null, leaseUntil: 0, retryAfter: 0 };

function ttlSeconds(value) {
  const seconds = Number(value);
  return Number.isInteger(seconds) && seconds >= 30 && seconds <= 3600 ? seconds : 300;
}

function respond(status, snapshot, now, maxAge) {
  const points = retained(snapshot.points, now).map(({ timestamp, ...point }) => ({
    ...point,
    age: Math.max(0, Math.round((now - timestamp) / 1000)),
  }));
  return Response.json({
    status, points, received: snapshot.received, updatedAt: snapshot.updatedAt,
    asOf: now, viewport: REGION,
  }, {
    headers: {
      "Cache-Control": "no-store",
      "Netlify-CDN-Cache-Control": `public, durable, max-age=${maxAge}, stale-while-revalidate=10`,
    },
  });
}

async function refresh(store, snapshot, etag, key, ttl, now, collectSnapshot) {
  // The lease and payload share a conditional-write key. A slow worker cannot
  // overwrite data after another invocation succeeds in taking the lease.
  const lease = await store.setJSON(BLOB_KEY, { ...snapshot, leaseUntil: now() + LEASE_MS },
    etag ? { onlyIfMatch: etag } : { onlyIfNew: true });
  if (!lease.modified) return;

  const started = now();
  let result;
  try {
    result = await collectSnapshot(key, snapshot.points);
  } catch {
    result = { healthy: false, points: snapshot.points, received: 0 };
  }
  console.log(`AIS collection ${result.healthy ? "ok" : "failed"}: ${result.received} vessels in ${Math.round((now() - started) / 1000)} s`);
  const finished = now();
  await store.setJSON(BLOB_KEY, {
    points: retained(result.points, finished),
    received: result.received,
    updatedAt: result.healthy ? finished : snapshot.updatedAt,
    leaseUntil: 0,
    retryAfter: result.healthy ? 0 : finished + Math.min(ttl, 60) * 1000,
  }, { onlyIfMatch: lease.etag });
}

export function createHandler({
  env = process.env,
  openStore = () => getStore({ name: "night-atlas-ais-v1", consistency: "strong" }),
  now = Date.now,
  collectSnapshot = (key, previous) => collect(key, previous, WebSocket),
} = {}) {
  return async (_request, context) => {
    const key = env.AISSTREAM_API_KEY?.trim();
    if (!key) return respond("not-configured", INITIAL, now(), 60);
    const ttl = ttlSeconds(env.AIS_SNAPSHOT_TTL_SECONDS);
    try {
      const store = openStore();
      const entry = await store.getWithMetadata(BLOB_KEY, { type: "json" });
      const snapshot = entry?.data ?? INITIAL;
      const time = now();
      const freshUntil = snapshot.updatedAt === null ? 0 : snapshot.updatedAt + ttl * 1000;
      if (freshUntil > time) {
        return respond("live", snapshot, time, Math.max(1, Math.floor((freshUntil - time) / 1000)));
      }
      if (snapshot.leaseUntil <= time && snapshot.retryAfter <= time) {
        const job = refresh(store, snapshot, entry?.etag, key, ttl, now, collectSnapshot)
          .catch(() => console.warn("AIS snapshot refresh failed"));
        if (typeof context?.waitUntil === "function") {
          context.waitUntil(job);
        } else {
          // Compatibility for local runners without waitUntil.
          await job;
          const next = (await store.getWithMetadata(BLOB_KEY, { type: "json" }))?.data ?? INITIAL;
          const after = now();
          const refreshed = next.updatedAt !== null && next.updatedAt + ttl * 1000 > after;
          const status = next.retryAfter > after ? "offline" :
            refreshed ? "live" : next.updatedAt !== null ? "stale" : "waiting";
          return respond(status, next, after, 10);
        }
      }
      const status = snapshot.retryAfter > time ? "offline" : snapshot.updatedAt !== null ? "stale" : "waiting";
      return respond(status, snapshot, time, 10);
    } catch {
      console.warn("AIS snapshot storage unavailable");
      return respond("offline", INITIAL, now(), 15);
    }
  };
}

export default createHandler();
export const config = { path: "/api/ships", method: "GET" };
