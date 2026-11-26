// Writes Brotli copies beside the map's text files. Run once at image build: maximum quality is too slow for startup.
import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { extname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { brotliCompressSync, constants } from "node:zlib";

const root = fileURLToPath(new URL("../web", import.meta.url));
const TEXT = new Set([".html", ".css", ".mjs", ".json", ".svg", ".txt"]);
for (const entry of readdirSync(root, { recursive: true, withFileTypes: true })) {
  if (!entry.isFile() || !TEXT.has(extname(entry.name))) continue;
  const path = join(entry.parentPath, entry.name), body = readFileSync(path);
  writeFileSync(path + ".br", brotliCompressSync(body, { params: {
    [constants.BROTLI_PARAM_QUALITY]: 11, [constants.BROTLI_PARAM_SIZE_HINT]: body.length } }));
}
