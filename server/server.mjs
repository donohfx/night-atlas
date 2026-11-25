// Night Atlas as one small always-on server: the static map, live ships and buoys.
import { createServer } from "node:http";
import { readdirSync, readFileSync } from "node:fs";
import { extname, join, relative } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createHash } from "node:crypto";
import { gzipSync } from "node:zlib";
import WebSocket from "ws";
import buoys from "../netlify/functions/buoys.mjs";
import { createFeed } from "./ais-live.mjs";

const TYPES = {
  ".html": "text/html; charset=utf-8", ".css": "text/css; charset=utf-8", ".mjs": "text/javascript; charset=utf-8",
  ".json": "application/json", ".jpg": "image/jpeg", ".svg": "image/svg+xml", ".txt": "text/plain; charset=utf-8",
};
const SECURITY = { "X-Content-Type-Options": "nosniff", "Referrer-Policy": "strict-origin-when-cross-origin" };

// Everything public is read into memory once; only these exact paths can be requested.
function loadFiles(root) {
  const files = new Map();
  for (const entry of readdirSync(root, { recursive: true, withFileTypes: true })) {
    if (!entry.isFile() || !TYPES[extname(entry.name)]) continue;
    const path = join(entry.parentPath, entry.name);
    const body = readFileSync(path), type = TYPES[extname(entry.name)];
    files.set("/" + relative(root, path), {
      body, type, gzip: type.startsWith("image/jpeg") ? null : gzipSync(body, { level: 9 }),
      etag: `"${createHash("sha1").update(body).digest("hex")}"`,
    });
  }
  files.set("/", files.get("/index.html"));
  return files;
}

export function createApp({ root, feed, buoyHandler = buoys }) {
  const files = loadFiles(root);
  let buoyCache = { at: 0, body: null };

  function send(req, res, status, headers, body, gzip) {
    const zipped = gzip && /\bgzip\b/.test(req.headers["accept-encoding"] || "");
    const data = zipped ? gzip : body;
    res.writeHead(status, { ...SECURITY, ...headers, Vary: "Accept-Encoding",
      ...(zipped ? { "Content-Encoding": "gzip" } : {}), "Content-Length": data.length });
    res.end(req.method === "HEAD" ? undefined : data);
  }
  const json = (req, res, status, value, cache) => {
    const body = Buffer.from(JSON.stringify(value));
    send(req, res, status, { "Content-Type": "application/json", "Cache-Control": cache }, body, gzipSync(body));
  };

  return createServer(async (req, res) => {
    try {
      if (req.method !== "GET" && req.method !== "HEAD") return send(req, res, 405, { Allow: "GET, HEAD" }, Buffer.alloc(0));
      const path = req.url.split("?")[0];
      if (path === "/api/ships") {
        return json(req, res, 200, feed ? feed.snapshot() : { status: "not-configured", points: [], asOf: Date.now() }, "no-store");
      }
      if (path === "/api/buoys") {
        if (Date.now() - buoyCache.at > (buoyCache.body?.stations.length ? 900_000 : 60_000)) {
          buoyCache.at = Date.now();
          const response = await buoyHandler(new Request("http://local/api/buoys"));
          const body = await response.json();
          if (body.stations.length || !buoyCache.body) buoyCache.body = body;
        }
        const body = buoyCache.body ?? { stations: [] };
        return json(req, res, body.stations.length ? 200 : 503, body, "public, max-age=60");
      }
      const file = files.get(path);
      if (!file) return send(req, res, 404, { "Content-Type": "text/plain" }, Buffer.from("Not found"));
      const headers = { "Content-Type": file.type, ETag: file.etag,
        "Cache-Control": path.startsWith("/vendor/") ? "public, max-age=86400" : "public, max-age=300" };
      if (req.headers["if-none-match"] === file.etag) { res.writeHead(304, { ...SECURITY, ETag: file.etag }); return res.end(); }
      send(req, res, 200, headers, file.body, file.gzip);
    } catch (error) {
      console.error("Request failed:", error.message);
      if (!res.headersSent) res.writeHead(500, SECURITY);
      res.end();
    }
  });
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  const key = process.env.AISSTREAM_API_KEY?.trim();
  const feed = key ? createFeed({ key, WebSocket }) : null;
  feed?.start();
  const server = createApp({ root: fileURLToPath(new URL("../web", import.meta.url)), feed });
  const port = Number(process.env.PORT) || 8080;
  server.listen(port, "0.0.0.0", () => console.log(`Night Atlas on :${port}, ships ${feed ? "on" : "not configured"}`));
  for (const signal of ["SIGINT", "SIGTERM"]) process.on(signal, () => { feed?.stop(); process.exit(0); });
}
