// Run with Node 24 and hardware-backed Chromium; set CHROME to its executable.
// Pass --check to compare the committed table against a fresh runtime computation.
import {spawn} from "node:child_process";
import {once} from "node:events";
import {mkdtemp, readFile, rm, writeFile} from "node:fs/promises";
import {createServer} from "node:http";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {setTimeout as delay} from "node:timers/promises";
import {brotliCompressSync, constants} from "node:zlib";

const root = new URL("../web/", import.meta.url);
const check = process.argv.includes("--check");
const tableFile = new URL("beam-reach.json", root);
const modules = new Set([
  "/atlas-shore.mjs", "/atlas-reach-table.mjs", "/land.json",
  "/chart-data.json", "/open-lights.json", "/beam-reach.json",
]);
const server = createServer(async (req, res) => {
  if (req.url === "/") {
    res.writeHead(200, {"Content-Type":"text/html"});
    return res.end("<!DOCTYPE html><title>Night Atlas shoreline build</title>");
  }
  try {
    if (!modules.has(req.url)) throw new Error("Unknown asset");
    const file = await readFile(new URL(req.url.slice(1), root));
    res.writeHead(200, {"Content-Type":req.url.endsWith(".mjs") ? "text/javascript" : "application/json"});
    res.end(file);
  } catch {
    res.writeHead(404).end();
  }
});

async function compute(check) {
  const {beamReach, shorelinePaths} = await import("/atlas-shore.mjs");
  const {decodeReach, encodeReach, lightKey, reachFormat, reachRevision, validatedReachTables}
    = await import("/atlas-reach-table.mjs");
  const read = async (path, format) => {
    const response = await fetch(path);
    if (!response.ok) throw new Error(`${path}: ${response.status}`);
    return response[format]();
  };
  const [land, combined, open] = await Promise.all([
    read("/land.json", "text"), read("/chart-data.json", "json"), read("/open-lights.json", "json"),
  ]);
  const shores = shorelinePaths(JSON.parse(land));
  const shoreline = await reachRevision(land);
  const table = {format:reachFormat, shoreline};
  const existing = check
    ? await validatedReachTables(await read("/beam-reach.json", "json"), shoreline, combined.lights, open.lights)
    : null;
  const stats = {};
  for (const [mode, {lights}] of Object.entries({combined, open})) {
    const entries = {};
    const differences = [];
    let lightCount = 0;
    // Every coloured light can be forced to sweep in combined mode. Include
    // the corresponding superset in open mode, where sweeps are disabled.
    for (const light of lights.filter(light => light.colors.length)) {
      const key = lightKey(light);
      const runtime = beamReach(light, shores);
      if (Object.hasOwn(entries, key)) throw new Error(`Duplicate light: ${key}`);
      entries[key] = check ? existing[mode]?.[key] : encodeReach(runtime);
      const decoded = decodeReach(entries[key]);
      if (!decoded) throw new Error(`Missing or invalid reach: ${mode} ${key}`);
      lightCount++;
      for (let i = 0; i < runtime.length; i++) differences.push(Math.abs(runtime[i] - decoded[i]));
    }
    differences.sort((a,b) => a-b);
    const percentile = p => differences[Math.ceil(p * differences.length) - 1];
    stats[mode] = {lights:lightCount, bearings:differences.length, p50:percentile(.5),
      p95:percentile(.95), p99:percentile(.99), max:percentile(1)};
    table[mode] = {revision:await reachRevision(JSON.stringify(lights)), entries};
  }
  return {stats, table:check ? null : table};
}

const profile = await mkdtemp(join(tmpdir(), "atlas-reach-"));
let chrome, socket;
try {
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const url = `http://127.0.0.1:${server.address().port}`;
  chrome = spawn(process.env.CHROME || "google-chrome", [
    "--headless=new", "--use-angle=vulkan", "--enable-gpu", "--ignore-gpu-blocklist",
    "--disable-software-rasterizer", "--no-first-run", "--disable-background-networking",
    `--user-data-dir=${profile}`, "--remote-debugging-port=0", url,
  ], {
    stdio:["ignore", "ignore", "pipe"],
    env:{...process.env, XDG_CONFIG_HOME:profile, XDG_CACHE_HOME:profile, CHROME_CONFIG_HOME:profile},
  });
  let chromeError, diagnostics = "";
  chrome.on("error", error => { chromeError = error; });
  chrome.stderr.on("data", chunk => { diagnostics = (diagnostics + chunk).slice(-4096); });
  let target;
  for (let i = 0; i < 100 && !target; i++) {
    if (chromeError) throw chromeError;
    if (chrome.exitCode !== null) throw new Error(diagnostics);
    try {
      const [port] = (await readFile(join(profile, "DevToolsActivePort"), "utf8")).split("\n");
      const tabs = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
      target = tabs.find(tab => tab.url === url + "/");
    } catch { /* Chrome is still starting. */ }
    if (!target) await delay(100);
  }
  if (!target) throw new Error(`Chrome did not start: ${diagnostics}`);
  socket = new WebSocket(target.webSocketDebuggerUrl);
  await once(socket, "open");
  const evaluate = async expression => {
    socket.send(JSON.stringify({id:1, method:"Runtime.evaluate",
      params:{expression, returnByValue:true, awaitPromise:true}}));
    const [message] = await once(socket, "message", {signal:AbortSignal.timeout(180000)});
    const {result, error} = JSON.parse(message.data);
    if (error || result.exceptionDetails)
      throw new Error(JSON.stringify(error || result.exceptionDetails));
    return result.result.value;
  };
  const renderer = await evaluate(`(() => {
    const gl = document.createElement("canvas").getContext("webgl2");
    const debug = gl?.getExtension("WEBGL_debug_renderer_info");
    return debug && gl.getParameter(debug.UNMASKED_RENDERER_WEBGL);
  })()`);
  if (!renderer || !/vulkan/i.test(renderer) || /swiftshader|llvmpipe|lavapipe/i.test(renderer))
    throw new Error(`Hardware Vulkan required: ${renderer}`);
  const {stats, table} = await evaluate(`(${compute})(${check})`);
  console.log(renderer);
  console.log("Absolute reach differences (metres)", JSON.stringify(stats));
  if (Object.values(stats).some(mode => mode.max !== 0)) throw new Error("Reach differs from runtime");
  const bytes = table ? Buffer.from(JSON.stringify(table) + "\n") : await readFile(tableFile);
  const brotli = brotliCompressSync(bytes, {params:{
    [constants.BROTLI_PARAM_QUALITY]:11, [constants.BROTLI_PARAM_SIZE_HINT]:bytes.length,
  }});
  console.log(`Payload: ${bytes.length} raw bytes, ${brotli.length} Brotli bytes`);
  if (table) await writeFile(tableFile, bytes);
} finally {
  socket?.close();
  if (chrome?.pid && chrome.exitCode === null && chrome.signalCode === null) {
    const exited = once(chrome, "exit");
    chrome.kill();
    await exited;
  }
  server.closeAllConnections();
  server.close();
  await rm(profile, {recursive:true, force:true});
}
