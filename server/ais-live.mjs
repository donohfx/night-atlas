// One long-lived AIS Stream subscription, shared by every visitor.
import { REGION, retained, TYPES, update, URL as STREAM } from "./ais.mjs";

const QUIET_MS = 120_000;                 // no message for this long means the link is dead
const SAVE_EVERY = 15_000;

export function createFeed({ key, WebSocket, now = Date.now, log = console.log }) {
  const vessels = new Map(), metadata = new Map(), seen = new Set();
  let socket, watchdog, retryTimer, lastMessage = 0, updatedAt = null, delay = 5000, stopped = false;

  function connect() {
    if (stopped) return;
    const current = socket = new WebSocket(STREAM, {
      perMessageDeflate: true, handshakeTimeout: 30_000, maxPayload: 64 * 1024,
    });
    let closed = false, heard = now();
    const reconnect = reason => {
      if (closed) return;
      closed = true;
      clearInterval(watchdog);
      current.terminate();
      if (stopped) return;
      log(`AIS link lost (${reason}); retrying in ${delay / 1000} s`);
      retryTimer = setTimeout(connect, delay);
      delay = Math.min(delay * 2, 120_000);
    };
    watchdog = setInterval(() => { if (now() - heard > QUIET_MS) reconnect("quiet"); }, SAVE_EVERY);
    current.on("error", error => reconnect(error.message));
    current.on("close", () => reconnect("closed"));
    current.on("open", () => {
      heard = now();
      const [west, south, east, north] = REGION;
      current.send(JSON.stringify({
        APIKey: key, BoundingBoxes: [[[north, west], [south, east]]], FilterMessageTypes: TYPES,
      }));
      log("AIS connected");
    });
    current.on("message", payload => {
      let event;
      try { event = JSON.parse(payload.toString()); } catch { return; }
      if (!event || typeof event !== "object") return;
      // Service errors are never logged verbatim.
      if ("error" in event || "Error" in event) return reconnect("service error");
      heard = now();
      if (!TYPES.includes(event.MessageType)) return;
      lastMessage = updatedAt = now();
      delay = 5000;
      update(event, vessels, metadata, seen, now());
    });
  }

  return {
    start: connect,
    stop() { stopped = true; clearInterval(watchdog); clearTimeout(retryTimer); socket?.terminate(); },
    snapshot() {
      const time = now();
      for (const [mmsi, point] of vessels) {
        if (!retained([point], time).length) { vessels.delete(mmsi); seen.delete(mmsi); }
      }
      const points = retained([...vessels.values()], time).map(({ timestamp, ...point }) => ({
        ...point, age: Math.max(0, Math.round((time - timestamp) / 1000)),
      }));
      const status = time - lastMessage < QUIET_MS ? "live" : updatedAt ? "stale" : "waiting";
      return { status, points, received: seen.size, updatedAt, asOf: time, viewport: REGION, refresh: 10 };
    },
  };
}
