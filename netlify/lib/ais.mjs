export const REGION = [-69.14, 42.83, -58.38, 47.63];
export const RETENTION_MS = 24 * 60 * 60 * 1000;
const MAX_VESSELS = 3000;
// AIS Stream often takes 15-25 s to accept a connection. Connect plus listen must stay under the
// function's 60 s limit.
const CONNECT_MS = 30_000;
const LISTEN_MS = 20_000;
const URL = "wss://stream.aisstream.io/v0/stream";

const POSITION = ["PositionReport", "StandardClassBPositionReport", "ExtendedClassBPositionReport"];
const STATIC = ["ShipStaticData", "StaticDataReport"];
const TYPES = [...POSITION, ...STATIC];

function cleanText(value) {
  if (typeof value !== "string") return "";
  return value.replace(/[\p{C}\p{Zl}\p{Zp}]/gu, "").replace(/^[ @]+|[ @]+$/g, "").slice(0, 60);
}

function bounded(value, limit) {
  return typeof value === "number" && value >= 0 && value < limit ? value : null;
}

export function retained(points, now) {
  return points.filter(point => now - point.timestamp < RETENTION_MS)
    .sort((a, b) => b.timestamp - a.timestamp).slice(0, MAX_VESSELS);
}

function update(event, vessels, metadataCache, seen, now) {
  const kind = event.MessageType;
  const report = event.Message?.[kind] ?? {};
  const metadata = event.MetaData ?? {};
  const mmsi = report.UserID ?? metadata.MMSI;
  if (!Number.isInteger(mmsi) || report.Valid === false) return;

  const previous = vessels.get(mmsi);
  const name = cleanText(metadata.ShipName);
  if (STATIC.includes(kind)) {
    const fields = {};
    const staticName = cleanText(report.Name || report.ReportA?.Name) || name;
    const destination = cleanText(report.Destination);
    const type = report.Type || report.ShipType || report.ReportB?.ShipType;
    if (staticName) fields.name = staticName;
    if (destination) fields.destination = destination;
    if (Number.isInteger(type) && type > 0 && type < 100) fields.type = type;
    if (metadataCache.size >= MAX_VESSELS && !metadataCache.has(mmsi)) {
      metadataCache.delete(metadataCache.keys().next().value);
    }
    metadataCache.set(mmsi, { ...metadataCache.get(mmsi), ...fields });
    if (previous) Object.assign(previous, fields);
    return;
  }

  const lat = report.Latitude ?? metadata.Latitude ?? metadata.latitude;
  const lon = report.Longitude ?? metadata.Longitude ?? metadata.longitude;
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) return;
  // AIS encodes missing coordinates as 91° / 181°.
  if (Math.abs(lat) > 90 || Math.abs(lon) > 180) return;
  const [west, south, east, north] = REGION;
  if (lat < south || lat > north || lon < west || lon > east) {
    vessels.delete(mmsi);
    return;
  }
  const fields = { ...previous, ...metadataCache.get(mmsi) };
  if (vessels.size >= MAX_VESSELS && !vessels.has(mmsi)) {
    vessels.delete(vessels.keys().next().value);
  }
  seen.add(mmsi);
  vessels.delete(mmsi);
  vessels.set(mmsi, {
    ...fields, mmsi, name: name || fields.name || "",
    lat: Number(lat.toFixed(5)), lon: Number(lon.toFixed(5)),
    speed: bounded(report.Sog, 102.3),
    course: bounded(report.Cog, 360),
    heading: bounded(report.TrueHeading, 360),
    timestamp: now,
  });
}

export function collect(key, previous, WebSocket, now = Date.now, listenMs = LISTEN_MS) {
  const vessels = new Map(retained(previous, now()).reverse().map(point => [point.mmsi, { ...point }]));
  const metadataCache = new Map();
  const seen = new Set();
  const [west, south, east, north] = REGION;

  return new Promise(resolve => {
    const socket = new WebSocket(URL, {
      perMessageDeflate: true,
      handshakeTimeout: CONNECT_MS,
      maxPayload: 64 * 1024,
    });
    let subscribed = false;
    let finished = false;
    const finish = (healthy) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      socket.terminate();
      resolve({
        healthy,
        points: retained([...vessels.values()], now()),
        received: seen.size,
      });
    };
    let timer = setTimeout(() => finish(false), CONNECT_MS);   // the listening clock starts on open
    socket.on("error", () => finish(false));
    socket.on("close", () => finish(false));
    socket.on("open", () => {
      clearTimeout(timer);
      timer = setTimeout(() => finish(subscribed), listenMs);
      socket.send(JSON.stringify({
        APIKey: key,
        BoundingBoxes: [[[north, west], [south, east]]],
        FilterMessageTypes: TYPES,
      }), error => {
        if (error) finish(false);
      });
    });
    socket.on("message", payload => {
      if (finished) return;
      let event;
      try {
        event = JSON.parse(payload.toString());
      } catch {
        return;
      }
      if (!event || typeof event !== "object") return;
      if ("error" in event || "Error" in event) {
        finish(false);
      } else if (event.MessageType === "SubscriptionConfirmation") {
        subscribed = true;
      } else if (TYPES.includes(event.MessageType)) {
        subscribed = true;
        update(event, vessels, metadataCache, seen, now());
      }
    });
  });
}
