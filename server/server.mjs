// Night Atlas as one small always-on server: the static map, live ships and buoys.
import { createServer } from "node:http";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { open } from "node:fs/promises";
import { pipeline } from "node:stream/promises";
import { extname, join, relative } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createHash } from "node:crypto";
import { gzipSync } from "node:zlib";
import WebSocket from "ws";
import { sendArchive } from "./tile-files.mjs";
import buoys from "./buoys.mjs";
import { createFeed } from "./ais-live.mjs";
import { createOpenWaters, withFallback } from "./openwaters.mjs";

const TYPES = {
  ".html": "text/html; charset=utf-8", ".css": "text/css; charset=utf-8", ".mjs": "text/javascript; charset=utf-8",
  ".json": "application/json", ".jpg": "image/jpeg", ".webp": "image/webp", ".svg": "image/svg+xml", ".txt": "text/plain; charset=utf-8",
};
const SECURITY = { "X-Content-Type-Options": "nosniff", "Referrer-Policy": "strict-origin-when-cross-origin" };
// These source assets are used by the untiled preview. Keep only their paths in memory.
const STREAMED = new Set([
  "/land.json", "/region/land.json", "/region/provinces.json", "/region/contours.json",
  "/region/relief.jpg", "/beam-reach.json", "/region/beam-reach.json",
]);

// Cache the small static responses. Archives are indexed by path and streamed on demand.
function loadFiles(root, archives) {
  const files = new Map();
  for (const entry of readdirSync(root, { recursive: true, withFileTypes: true })) {
    if (!entry.isFile()) continue;
    const path = join(entry.parentPath, entry.name);
    const route = "/" + relative(root, path);
    if (/^\/tiles\/[a-z0-9-]+\.pmtiles$/.test(route)) {
      archives.set(route, path);
      continue;
    }
    if (!TYPES[extname(entry.name)]) continue;
    const type = TYPES[extname(entry.name)];
    const text = !/^image\/(jpeg|webp)/.test(type);
    const brPath = text && existsSync(path + ".br") ? path + ".br" : null;
    if (STREAMED.has(route)) {
      files.set(route, { path, type, brPath });
      continue;
    }
    const body = readFileSync(path);
    files.set(route, {
      body, type, gzip: text ? gzipSync(body, { level: 9 }) : null,
      br: brPath ? readFileSync(brPath) : null,   // made by precompress.mjs
      hash: createHash("sha1").update(body).digest("hex"),
    });
  }
  files.set("/", files.get("/index.html"));
  return files;
}

const accepts = (req, name) => String(req.headers["accept-encoding"] || "").split(",").some(part => {
  const [coding, ...params] = part.trim().toLowerCase().split(";");
  return coding === name && !params.some(p => /^\s*q=0(\.0*)?\s*$/.test(p));
});
const encodingFor = (req, { br, gzip }) => br && accepts(req, "br") ? "br" : gzip && accepts(req, "gzip") ? "gzip" : null;

async function sendSource(req, res, { path, type, brPath }) {
  const encoding = brPath && accepts(req, "br") ? "br" : null;
  const file = await open(encoding ? brPath : path, "r");
  try {
    const { size, mtimeMs } = await file.stat();
    const etag = `"${size.toString(16)}-${mtimeMs}${encoding ? "-br" : ""}"`;
    const headers = { ...SECURITY, ETag: etag, Vary: "Accept-Encoding", "Cache-Control": "public, max-age=300" };
    if (req.headers["if-none-match"] === etag) {
      res.writeHead(304, headers);
      return res.end();
    }
    res.writeHead(200, { ...headers, "Content-Type": type, "Content-Length": size,
      ...(encoding ? { "Content-Encoding": encoding } : {}) });
    if (req.method === "HEAD") return res.end();
    await pipeline(file.createReadStream({ autoClose: false }), res).catch(error => {
      if (error.code !== "ERR_STREAM_PREMATURE_CLOSE") throw error;
    });
  } finally {
    await file.close();
  }
}
const prepare = value => {
  const body = Buffer.from(JSON.stringify(value));
  return { body, gzip: gzipSync(body) };
};

export function createApp({ root, feed, buoyHandler = buoys, redirects = {}, tileBase = process.env.ATLAS_TILE_BASE_URL || "/tiles/" }) {
  const archives = new Map();
  const files = loadFiles(root, archives);
  const tileConfig = prepare({tileBase});
  const SHIPS_MS = 1000;                  // one prepared snapshot serves everyone who asks within a second
  let ships = { at: 0, ready: null };
  const buoyCache = { at: 0, ready: prepare({ stations: [] }), ok: false, pending: null };

  function send(req, res, status, headers, content) {
    const encoding = encodingFor(req, content);
    const data = encoding ? content[encoding] : content.body;
    res.writeHead(status, { ...SECURITY, ...headers, Vary: "Accept-Encoding",
      ...(encoding ? { "Content-Encoding": encoding } : {}), "Content-Length": data.length });
    res.end(req.method === "HEAD" ? undefined : data);
  }
  const json = (req, res, status, ready, headers) =>
    send(req, res, status, { "Content-Type": "application/json", ...headers }, ready);
  const plain = text => ({ body: Buffer.from(text) });

  // Everyone arriving during a refresh shares it. A failed refresh keeps the last good readings.
  function refreshBuoys() {
    buoyCache.pending ??= (async () => {
      try {
        const body = await buoyHandler();
        if (body.stations.length) { buoyCache.ready = prepare(body); buoyCache.ok = true; }
      } catch (error) {
        console.error("Buoy refresh failed:", error.message);
      } finally {
        buoyCache.at = Date.now();
        buoyCache.pending = null;
      }
    })();
    return buoyCache.pending;
  }

  return createServer(async (req, res) => {
    try {
      if (req.method !== "GET" && req.method !== "HEAD") return send(req, res, 405, { Allow: "GET, HEAD" }, plain(""));
      // Old addresses keep working: same path, permanent redirect.
      const moved = redirects[String(req.headers.host || "").toLowerCase().split(":")[0]];
      if (moved && req.url.startsWith("/")) {
        res.writeHead(301, { ...SECURITY, Location: `https://${moved}${req.url}`, "Content-Length": 0 });
        return res.end();
      }
      const path = req.url.split("?")[0];
      if (archives.has(path)) return await sendArchive(req, res, archives.get(path), SECURITY);
      if (path === "/api/map-tiles") return json(req, res, 200, tileConfig, {"Cache-Control":"no-cache"});
      if (path === "/api/ships") {
        if (!ships.ready || Date.now() - ships.at >= SHIPS_MS) {
          ships = { at: Date.now(),
            ready: prepare(feed ? feed.snapshot() : { status: "not-configured", points: [], asOf: Date.now() }) };
        }
        return json(req, res, 200, ships.ready, { "Cache-Control": "no-store" });
      }
      if (path === "/api/buoys") {
        if (buoyCache.pending || Date.now() - buoyCache.at > (buoyCache.ok ? 900_000 : 60_000)) {
          const refresh = refreshBuoys();
          if (!buoyCache.ok) await refresh;    // nothing to show yet; otherwise answer now with what we have
        }
        return buoyCache.ok
          ? json(req, res, 200, buoyCache.ready, { "Cache-Control": "public, max-age=60" })
          : json(req, res, 503, buoyCache.ready, { "Cache-Control": "no-store", "Retry-After": "60" });
      }
      const file = files.get(path);
      if (!file) return send(req, res, 404, { "Content-Type": "text/plain" }, plain("Not found"));
      if (file.path) return await sendSource(req, res, file);
      const encoding = encodingFor(req, file);
      const etag = `"${file.hash}${encoding ? "-" + encoding : ""}"`;
      const headers = { "Content-Type": file.type, ETag: etag,
        "Cache-Control": path.startsWith("/vendor/") ? "public, max-age=86400" : "public, max-age=300" };
      if (req.headers["if-none-match"] === etag) {
        res.writeHead(304, { ...SECURITY, ETag: etag, Vary: "Accept-Encoding", "Cache-Control": headers["Cache-Control"] });
        return res.end();
      }
      send(req, res, 200, headers, file);
    } catch (error) {
      console.error("Request failed:", error.message);
      if (!res.headersSent) res.writeHead(500, SECURITY);
      res.end();
    }
  });
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  const key = process.env.AISSTREAM_API_KEY?.trim();
  // Open Waters first; AIS Stream (when a key is set) covers its outages. OPENWATERS=off disables it.
  const feeds = [
    process.env.OPENWATERS !== "off" && createOpenWaters({
      userAgent: process.env.OPENWATERS_USER_AGENT?.trim() || "harbour-map/1.0" }),
    key && createFeed({ key, WebSocket }),
  ].filter(Boolean);
  const feed = feeds.length ? withFallback(feeds) : null;
  feed?.start();
  // REDIRECTS="old.example=new.example,other.example=new.example"
  const redirects = Object.fromEntries((process.env.REDIRECTS || "").split(",").filter(Boolean).map(pair => pair.trim().split("=")));
  const server = createApp({ root: fileURLToPath(new URL("../web", import.meta.url)), feed, redirects });
  const port = Number(process.env.PORT) || 8080;
  server.listen(port, "0.0.0.0", () => console.log(`Harbour Watch on :${port}, ships ${feed ? "on" : "not configured"}`));
  for (const signal of ["SIGINT", "SIGTERM"]) process.on(signal, () => { feed?.stop(); process.exit(0); });
}
