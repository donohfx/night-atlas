import assert from "node:assert/strict";
import {spawn} from "node:child_process";
import fs from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import {brotliCompressSync, constants, gzipSync} from "node:zlib";
import {sendArchive} from "../server/tile-files.mjs";

const [kind, root, output, fixtureRoot] = process.argv.slice(2);
assert(["web", "desktop", "tiles"].includes(kind) && root && output && fixtureRoot,
  "Usage: node tools/verify-shared-core.mjs web|desktop|tiles ASSET_DIR OUTPUT_DIR WEB_FIXTURE_DIR");
const desktop = kind === "desktop";
const tileComparison = kind === "tiles";
const compressBrotli = process.env.ATLAS_VERIFY_BROTLI === "1";
const work = await fs.mkdtemp(path.join(os.tmpdir(), "atlas-visual-chrome-"));
await fs.mkdir(output, {recursive:true});
const stamp = 1795610000000;
const weather = {visibility:30000, weather_code:0, cloud_cover:0, cloud_cover_low:0, wind_speed_10m:8,
  wind_direction_10m:225, wind_gusts_10m:12, temperature_2m:7, apparent_temperature:4, precipitation:0};
const fog = {...weather, visibility:100, weather_code:45, cloud_cover:65, cloud_cover_low:65};
const ships = {points:[{mmsi:123456789, lon:-63.56, lat:44.657, age:1, course:175, speed:9,
  name:"RITA JOE", type:"Passenger"}], status:"live", refresh:60, asOf:stamp};
if (tileComparison) {
  // At the same stale fix, the faster track has already intersected land.
  for (const [mmsi,speed] of [[123456790,2],[123456791,8]]) {
    ships.points.push({mmsi,lon:-63.56,lat:44.657,age:1300,course:290,speed,
      name:"GHOST FIXTURE",type:"Passenger"});
  }
}
const buoys = [{id:"44258", name:"Halifax Harbour", coordinates:[-63.4,44.50], observed:stamp/1000,
  WDIR:225, WSPD:8, GST:12, WVHT:1.5, DPD:9, WTMP:9}];
let settings = {mode:"chart", layers:{openSources:false}}, command = null, sweeps = {};
const counts = {};
const transferred = {};
const byteSnapshots = {};
const encoded = new Map();
const presets = [];
const mime = {".html":"text/html",".mjs":"text/javascript",".css":"text/css",".json":"application/json",
  ".jpg":"image/jpeg",".webp":"image/webp",".svg":"image/svg+xml"};
const missing = [];
let origin;
const server = http.createServer(async (req,res) => {
  const name = new URL(req.url, origin).pathname.slice(1) || "index.html";
  counts[name] = (counts[name] || 0) + 1;
  if (tileComparison) {
    const writeHead = res.writeHead.bind(res);
    let length = 0;
    res.writeHead = (status, headers) => {
      length = Number(headers?.["Content-Length"] || 0);
      return writeHead(status, headers);
    };
    res.once("finish", () => {
      transferred[name] = (transferred[name] || 0) + length;
    });
    if (/^tiles\/[a-z0-9-]+\.pmtiles$/.test(name)) {
      try { return await sendArchive(req,res,path.join(root,name),{}); }
      catch (error) {
        if (error.code !== "ENOENT") throw error;
        missing.push(name);
        return res.writeHead(404).end();
      }
    }
  }
  const json = data => {
    const body = JSON.stringify(data);
    res.writeHead(200, {"Content-Type":"application/json","Content-Length":Buffer.byteLength(body)}).end(body);
  };
  if (name === "state") return json({settings, command, ships, weather, buoys, sweeps});
  if (name === "command") return json(command);
  if (name === "viewport") return json(null);
  if (name === "preset") {
    let data = "";
    for await (const chunk of req) data += chunk;
    presets.push(JSON.parse(data));
    return json(null);
  }
  if (tileComparison && name === "api/map-tiles") return json({tileBase:"/tiles/"});
  if (name === "api/ships") return json(ships);
  if (name === "api/buoys") return json({stations:buoys});
  if (name === "fixture/weather") return json({current:weather});
  if (name === "fixture/tiles.json") return json({tilejson:"3.0.0", tiles:[origin+"/fixture/empty/{z}/{x}/{y}.pbf"], maxzoom:14});
  if (name === "favicon.ico" || name.startsWith("fixture/empty/")) return res.end();
  if (name === "fixture/counter.js") return res.writeHead(200, {"Content-Type":"text/javascript"}).end();
  try {
    let data;
    try { data = await fs.readFile(path.join(root, name)); }
    catch (error) {
      if (!desktop) throw error;
      if (name === "tss-traced.json") return json({type:"FeatureCollection", features:[]});
      if (name === "palette.json") data = await fs.readFile(path.join(fixtureRoot, name));
      else {
        data = await fs.readFile(path.join(root,name+".gz"));
        res.setHeader("Content-Encoding","gzip");
      }
    }
    if (/\.(html|mjs)$/.test(name) && !name.startsWith("vendor/")) {
      data = data.toString()
        .replaceAll("https://tiles.openfreemap.org/planet/latest", origin+"/fixture/tiles.json")
        .replaceAll("https://tiles.openfreemap.org/fonts", origin+"/fixture/empty")
        .replaceAll("https://api.open-meteo.com/v1/forecast", origin+"/fixture/weather")
        .replaceAll("https://gc.zgo.at/count.js", origin+"/fixture/counter.js");
      if (tileComparison && name === "map.mjs") data = data.replace("} = atlas;", "} = atlas; window.__atlas = atlas;");
    }
    const headers = {"Content-Type":mime[path.extname(name)] || "application/octet-stream"};
    if (tileComparison) {
      if (/\.(html|css|mjs|json|svg)$/.test(name)) {
        const encoding = compressBrotli ? "br" : "gzip";
        if (!encoded.has(name)) encoded.set(name, compressBrotli ? brotliCompressSync(Buffer.from(data), {
          params:{[constants.BROTLI_PARAM_QUALITY]:11},
        }) : gzipSync(data,{level:9}));
        data = encoded.get(name);
        headers["Content-Encoding"] = encoding;
      }
      headers["Content-Length"] = Buffer.byteLength(data);
      headers["Cache-Control"] = "public, max-age=300";
    }
    res.writeHead(200, headers).end(data);
  } catch (error) {
    missing.push(name);
    res.writeHead(404).end();
  }
});
const rendererHardware = renderer => /AMD|Radeon|NVIDIA|Intel/i.test(renderer) &&
  !/SwiftShader|llvmpipe|lavapipe|software/i.test(renderer);
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const wait = async (fn,label,limit=12000) => {
  const start = performance.now();
  do {
    if (await fn()) return;
    await sleep(100);
  } while (performance.now()-start < limit);
  throw new Error("Timed out waiting for "+label);
};
const sockets = [];
const errors = [];
const warnings = [];
async function connect(url) {
  const socket = new WebSocket(url);
  sockets.push(socket);
  await new Promise((resolve,reject) => {
    socket.onopen = resolve;
    socket.onerror = reject;
  });
  let id = 0;
  const pending = new Map();
  socket.onmessage = event => {
    const message = JSON.parse(event.data);
    const {method, params} = message;
    if (method === "Runtime.exceptionThrown") errors.push(params.exceptionDetails);
    if (method === "Log.entryAdded" && params.entry.level === "error") errors.push(params.entry);
    if (method === "Runtime.consoleAPICalled" && ["error","assert"].includes(params.type)) errors.push(params.args);
    if (method === "Runtime.consoleAPICalled" && params.type === "warning") warnings.push(params.args.map(arg => arg.value || arg.description));
    if (pending.has(message.id)) {
      const {resolve,reject} = pending.get(message.id);
      pending.delete(message.id);
      if (message.error) reject(new Error(JSON.stringify(message.error)));
      else resolve(message.result);
    }
  };
  return (method,params={}) => new Promise((resolve,reject) => {
    pending.set(++id,{resolve,reject});
    socket.send(JSON.stringify({id,method,params}));
  });
}

let chrome;
let renderer;
const frames = {};
let browser;
try {
  await new Promise((resolve,reject) => server.once("error",reject).listen(0,"127.0.0.1",resolve));
  origin = "http://127.0.0.1:"+server.address().port;
  const log = await fs.open(path.join(output,"chrome.log"),"w");
  chrome = spawn(process.env.CHROME || "/opt/google/chrome/chrome", [
    "--headless=new","--enable-gpu","--use-angle=vulkan","--ignore-gpu-blocklist","--disable-software-rasterizer",
    "--no-sandbox","--no-first-run","--disable-background-networking","--disable-breakpad","--disable-sync",
    "--disable-gpu-shader-disk-cache","--remote-debugging-port=0","--user-data-dir="+path.join(work,"profile"),"about:blank",
  ], {detached:true, stdio:["ignore",log.fd,log.fd],env:{...process.env,
    XDG_CONFIG_HOME:path.join(work,"config"),XDG_CACHE_HOME:path.join(work,"cache"),
    CHROME_CONFIG_HOME:path.join(work,"config"), MESA_SHADER_CACHE_DIR:path.join(work,"mesa")}});
  await log.close();
  let port;
  await wait(async () => {
    try { port = (await fs.readFile(path.join(work,"profile/DevToolsActivePort"),"utf8")).split("\n")[0]; return true; }
    catch { return false; }
  }, "Chrome DevTools");
  const get = async name => (await fetch("http://127.0.0.1:"+port+"/json/"+name)).json();
  browser = await connect((await get("version")).webSocketDebuggerUrl);
  renderer = (await browser("SystemInfo.getInfo")).gpu.auxAttributes?.glRenderer || "";
  assert(rendererHardware(renderer), "Hardware Chrome renderer required: "+renderer);
  console.log(renderer);
  const cdp = await connect((await get("list")).find(tab => tab.type === "page").webSocketDebuggerUrl);
  const evaluate = async expression => {
    const response = await cdp("Runtime.evaluate",{expression,returnByValue:true,awaitPromise:true});
    if (response.exceptionDetails) throw new Error(JSON.stringify(response.exceptionDetails));
    return response.result.value;
  };
  const ready = expression => async () => {
    try { return await evaluate(expression); }
    catch { return false; }
  };
  await cdp("Runtime.enable");
  await cdp("Log.enable");
  await cdp("Page.enable");
  await cdp("Network.enable");
  await cdp("Network.setCacheDisabled",{cacheDisabled:!tileComparison});
  await cdp("Emulation.setDeviceMetricsOverride",{width:1440,height:900,deviceScaleFactor:1,mobile:false});
  await cdp("Page.addScriptToEvaluateOnNewDocument",{source:`
    window.__visualClock=${stamp};
    Date.now=()=>window.__visualClock;
    let seed=7205;
    Math.random=()=>((seed=(Math.imul(1664525,seed)+1013904223)>>>0)/4294967296);
    window.__renderers=new Set();
    const original=HTMLCanvasElement.prototype.getContext;
    HTMLCanvasElement.prototype.getContext=function(type,...args) {
      const context=original.call(this,type,...args);
      if (context && type.startsWith("webgl")) {
        const debug=context.getExtension("WEBGL_debug_renderer_info");
        if (debug) __renderers.add(context.getParameter(debug.UNMASKED_RENDERER_WEBGL));
      }
      return context;
    };
    if (!location.search.includes("retain")) {
      localStorage.setItem("night-atlas.preferences",JSON.stringify({mode:"chart",view:"${tileComparison ? "nova-scotia" : "halifax-coast"}"}));
    }
  `});
  async function shot(name) {
    frames[name] = await evaluate('({status:document.querySelector("#status").textContent, details:document.querySelector("#details").hidden ? "" : document.querySelector("#details").textContent, simulated:document.querySelector("#simulated-weather")?.hidden === false, filter:document.querySelector(".maplibregl-canvas").style.filter})');
    const {data} = await cdp("Page.captureScreenshot",{format:"png",captureBeyondViewport:false});
    await fs.writeFile(path.join(output,name+".png"), Buffer.from(data,"base64"));
    console.log("Captured",name);
  }
  async function navigate(query="") {
    await cdp("Page.navigate",{url:origin+"/?"+query});
    await wait(ready(desktop ? 'window.setAtlasPaused && document.querySelector("#status").textContent.includes("AIS live")'
      : 'document.querySelector("#tour")?.disabled === false && document.querySelector("#status").textContent.includes("AIS live")'),"map and AIS");
    assert((await evaluate("[...__renderers]")).some(rendererHardware),"No hardware renderer in the map");
    await sleep(2100);
  }
  function advanceWeather(steps) {
    return evaluate(`new Promise(resolve => {
      let remaining=${steps};
      const timer=setInterval(() => {
        window.__visualClock+=95;
        if (--remaining>0) return;
        clearInterval(timer);
        setTimeout(resolve,75);
      },45);
    })`);
  }
  const click = selector => evaluate(`document.querySelector(${JSON.stringify(selector)}).click()`);
  const credit = open => ready(`document.querySelector("[data-ccg-credit]").hidden === ${open}`);
  if (tileComparison) {
    const settle = async () => {
      await wait(ready("window.__atlas?.map.loaded() && window.__atlas.map.areTilesLoaded()"),"visible tiles",30000);
      await sleep(1400);
    };
    const camera = (center,zoom) => evaluate(`window.__atlas.map.jumpTo(${JSON.stringify({center,zoom})}); true`);
    const captures = [
      ["overview",null,null], ["halifax",[-63.585,44.651],12.5], ["sambro",[-63.57,44.455],11.5],
      ["halifax-close",[-63.585,44.651],15.5],
    ];
    try { await navigate(); }
    catch (error) {
      console.log(await evaluate(`({status:document.querySelector("#status").textContent,
        loaded:__atlas.map.loaded(), tiles:__atlas.map.areTilesLoaded(),
        states:__atlas.map.style.tileManagers.relief._inViewTiles.getAllTiles().map(t=>[t.tileID.key,t.state]),
        sources:Object.keys(__atlas.map.getStyle().sources).map(name=>[name,__atlas.map.isSourceLoaded(name)])})`));
      console.log(warnings);
      throw error;
    }
    const overviewCamera = await evaluate("({center:__atlas.map.getCenter().toArray(),zoom:__atlas.map.getZoom()})");
    for (const [name,center,zoom] of captures) {
      if (center) await camera(center,zoom);
      await settle();
      if (name === "halifax") {
        await wait(ready(`__atlas.map.getSource("ghosts").getData().then(data =>
          JSON.stringify(data.features.filter(f=>f.geometry.type==="Point").map(f=>f.id))==="[123456790]")`),
          "ghost before and after landfall");
      }
      await shot(name+"-chart");
      byteSnapshots[name] = {...transferred};
    }
    await click("#mode");
    await wait(ready('document.querySelector("#mode").classList.contains("is-night")'),"web night mode");
    for (const [name,center,zoom] of captures.toReversed()) {
      if (center) await camera(center,zoom);
      else await camera(overviewCamera.center,overviewCamera.zoom);
      await settle();
      await shot(name+"-night");
    }
  } else if (desktop) {
    await navigate();
    for (const view of ["halifax","halifax-coast","nova-scotia"]) {
      command = {id:view,view};
      await wait(() => presets.at(-1) === view,view+" preset callback");
      await sleep(500);
      await shot("preset-"+view);
    }
    command = {id:"coast-a",view:"halifax-coast"};
    await wait(() => presets.at(-1) === "halifax-coast","coast preset callback");
    await evaluate("setAtlasPaused(true)");
    await sleep(350);
    const before = [counts.state,counts.command];
    await shot("covered");
    command = {id:"covered-harbour",view:"halifax"};
    await sleep(1300);
    assert.deepEqual([counts.state,counts.command],before,"Bridge polls continued while covered");
    assert.equal(presets.at(-1),"halifax-coast");
    await evaluate("setAtlasPaused(false)");
    await wait(() => presets.at(-1) === "halifax","queued harbour preset after uncover");
    settings = {mode:"night",layers:{openSources:true, labels:true}};
    await wait(credit(true),"desktop menu open-source setting");
    await sleep(1800);
    await shot("menu-night-open");
    settings = {mode:"night",layers:{openSources:false}};
    await wait(credit(false),"desktop menu combined-source setting");
    await sleep(1200);
    await shot("menu-night-combined");
    command = {id:"peggys-camera",view:"camera",center:[-63.91867,44.49178],zoom:12.6};
    await wait(() => presets.at(-1) === null,"custom camera");
    for (const enabled of [false,true]) {
      sweeps = {H3660:enabled};
      await sleep(1500);
      await shot("sweep-"+(enabled ? "on" : "off"));
    }
    settings = {mode:"chart",layers:{openSources:false,labels:false}};
    sweeps = {};
    command = {id:"before-tour",view:"nova-scotia"};
    await wait(() => presets.at(-1) === "nova-scotia","overview before desktop tour");
    await sleep(1300);
    command = {id:"tour",view:"tour"};
    await wait(() => presets.at(-1) === null,"desktop tour via command");
    const started = performance.now();
    for (const [seconds,name] of [[1,"overview"],[10,"peggys"],[18,"approaches"],[25,"ferry"],[29,"night"]]) {
      await sleep(Math.max(0,seconds*1000-(performance.now()-started)));
      await shot("tour-"+name);
    }
    await wait(() => presets.at(-1) === "nova-scotia","desktop tour returned to overview");
    await sleep(500);
    await shot("tour-final");
  } else {
    await navigate();
    await shot("chart");
    await click("#mode");
    await wait(ready('document.querySelector("#mode").classList.contains("is-night")'),"web night mode");
    await sleep(900);
    await shot("night");
    const toggle = () => evaluate('[...document.querySelectorAll("#layers input")].find(input=>input.parentElement.textContent.trim()==="Open sources only").click()');
    await toggle();
    await wait(credit(true),"web open-source toggle");
    await sleep(1000);
    await shot("open");
    await toggle();
    await wait(credit(false),"web combined-source toggle");
    await sleep(1000);
    await shot("combined");
    await navigate("retain&visibility="+fog.visibility+"&weather_code=45&cloud_cover=65&cloud_cover_low=65");
    await advanceWeather(35);
    await wait(ready('document.querySelector(".maplibregl-canvas").style.filter.includes("blur")'),"settled fog");
    await shot("fog");
    await click("#tour");
    await wait(ready('document.body.classList.contains("touring")'),"web tour start");
    const started = performance.now();
    for (const [seconds,name] of [[2,"overview"],[12,"ferry"],[16,"night"],[25,"peggys"],[37,"sambro"]]) {
      await sleep(Math.max(0,seconds*1000-(performance.now()-started)));
      await shot("tour-"+name);
    }
    await wait(ready('document.querySelector("#simulated-weather").hidden === false'),"tour fog switch");
    await advanceWeather(35);
    await wait(ready('document.querySelector(".maplibregl-canvas").style.filter.includes("blur")'),"settled tour fog");
    await shot("tour-fog");
    await sleep(Math.max(0,43200-(performance.now()-started)));
    await advanceWeather(35);
    await wait(ready('!document.querySelector(".maplibregl-canvas").style.filter'),"tour fog lifting");
    await shot("tour-clear");
    await wait(ready('!document.body.classList.contains("touring")'),"web tour final hold",20000);
    await sleep(500);
    await shot("tour-final");
  }
} finally {
  await fs.writeFile(path.join(output,"events.json"),JSON.stringify({renderer,errors,warnings,missing,counts,presets,frames,byteSnapshots},null,2));
  if (browser) await Promise.race([browser("Browser.close").catch(()=>{}),sleep(400)]);
  for (const socket of sockets) socket.close();
  if (chrome?.pid) {
    try { process.kill(-chrome.pid,"SIGTERM"); } catch (error) { if (error.code !== "ESRCH") throw error; }
    if (chrome.exitCode === null && chrome.signalCode === null) await Promise.race([new Promise(r=>chrome.once("exit",r)),sleep(1500)]);
    try { process.kill(-chrome.pid,"SIGKILL"); } catch (error) { if (error.code !== "ESRCH") throw error; }
  }
  server.closeAllConnections();
  server.close();
  await fs.rm(work,{recursive:true,force:true});
}
assert.deepEqual(errors,[],"Unexpected console errors");
assert.deepEqual(missing,[],"Unexpected missing assets");
