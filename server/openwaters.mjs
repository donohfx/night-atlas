// Ship positions from Open Waters AIS: one polled snapshot, shared by every visitor.
// Data keeps each source's own terms; the page credits them. https://openwaters.io/license/
import { REGION, retained } from "./ais.mjs";

const [WEST, SOUTH, EAST, NORTH] = REGION;
export const SNAPSHOT_URL = "https://ais.openwaters.io/v1/vessels"
  + `?bbox=${SOUTH},${WEST},${NORTH},${EAST}&kind=vessel&max_age=24h`;
const POLL_MS = 20_000, SLOWEST_MS = 300_000;
export const HEALTHY_MS = 120_000;

const text = value => typeof value !== "string" ? ""
  : value.replace(/[\p{C}\p{Zl}\p{Zp}]/gu, "").replace(/^[ @]+|[ @]+$/g, "").slice(0, 60);
const bounded = (value, limit) => typeof value === "number" && value >= 0 && value < limit ? value : null;

export function vessel(feature, now) {
  const p = feature?.properties ?? {};
  const [lon, lat] = feature?.geometry?.coordinates ?? [];
  const mmsi = p.mmsi, seen = Date.parse(p.seen);
  if (!Number.isInteger(mmsi) || !Number.isFinite(seen)) return null;
  if (!(lat >= SOUTH && lat <= NORTH && lon >= WEST && lon <= EAST)) return null;
  const point = {
    mmsi, name: text(p.name), lat: Number(lat.toFixed(5)), lon: Number(lon.toFixed(5)),
    speed: bounded(p.sog, 102.3), course: bounded(p.cog, 360), heading: bounded(p.heading, 360),
    timestamp: Math.min(seen, now),
  };
  const destination = text(p.destination);
  if (destination) point.destination = destination;
  if (Number.isInteger(p.type) && p.type > 0 && p.type < 100) point.type = p.type;
  for (const [key, value] of [["length", p.length], ["width", p.beam]]) {
    if (value > 0 && value <= 500) point[key] = value;
  }
  return point;
}

export function createOpenWaters({ userAgent, fetch = globalThis.fetch, now = Date.now, log = console.log }) {
  const vessels = new Map();
  let timer, updatedAt = null, delay = POLL_MS, stopped = false, failing = false;

  async function poll() {
    try {
      const response = await fetch(SNAPSHOT_URL, {
        headers: { "User-Agent": userAgent }, signal: AbortSignal.timeout(15_000),
      });
      if (!response.ok) {
        const wait = Number(response.headers.get("retry-after")) * 1000;
        if (wait > 0) delay = Math.min(wait, SLOWEST_MS);
        throw new Error(`HTTP ${response.status}`);
      }
      const { features } = await response.json();
      if (!Array.isArray(features)) throw new Error("unexpected response");
      const time = now();
      for (const point of features.map(feature => vessel(feature, time))) {
        if (point && !(vessels.get(point.mmsi)?.timestamp > point.timestamp)) vessels.set(point.mmsi, point);
      }
      // An answer with no ships at all is an outage upstream, not an empty sea.
      if (!features.length) throw new Error("no vessels returned");
      updatedAt = time;
      delay = POLL_MS;
      if (failing) log("Open Waters recovered");
      failing = false;
    } catch (error) {
      if (!failing) log(`Open Waters unavailable (${error.message})`);
      failing = true;
      delay = Math.min(delay * 2, SLOWEST_MS);
    }
    if (!stopped) timer = setTimeout(poll, delay);
  }

  return {
    start: poll,
    stop() { stopped = true; clearTimeout(timer); },
    snapshot() {
      const time = now();
      for (const [mmsi, point] of vessels) if (!retained([point], time).length) vessels.delete(mmsi);
      const points = retained([...vessels.values()], time).map(({ timestamp, ...point }) => ({
        ...point, age: Math.max(0, Math.round((time - timestamp) / 1000)),
      }));
      const status = updatedAt === null ? "waiting" : time - updatedAt < HEALTHY_MS ? "live" : "stale";
      return { status, points, received: vessels.size, updatedAt, asOf: time, viewport: REGION, refresh: 10 };
    },
  };
}

// Serves the first live feed; the others stay connected so a switch is immediate.
export function withFallback(feeds) {
  return {
    start() { for (const feed of feeds) feed.start(); },
    stop() { for (const feed of feeds) feed.stop(); },
    snapshot() {
      const snapshots = feeds.map(feed => feed.snapshot());
      return snapshots.find(snapshot => snapshot.status === "live")
        ?? snapshots.find(snapshot => snapshot.points.length) ?? snapshots[0];
    },
  };
}
