import {BEARING, createAtlas, defaultLayers, freshAge, jsonReader, mapBounds, overview} from "./atlas-core.mjs";
import {aidName} from "./atlas-marks.mjs";
import {biggestInHarbour} from "./atlas-extras.mjs";

const requestOptions = () => ({signal: AbortSignal.timeout(30000)});
const read = jsonReader(requestOptions);
const storageKey = "night-atlas.preferences";
let saved = {};
try {
  saved = JSON.parse(localStorage.getItem(storageKey)) || {};
} catch {}
const preferences = {
  mode:["chart","night","auto"].includes(saved.mode) ? saved.mode : "auto",
  view:["halifax","halifax-coast","nova-scotia"].includes(saved.view) ? saved.view : "nova-scotia",
  layers:{...defaultLayers},
};
for (const id of Object.keys(defaultLayers)) {
  if (typeof saved.layers?.[id] === "boolean") preferences.layers[id] = saved.layers[id];
}
// Pretend weather for a look on a fine day, e.g. ?visibility=300&cloud_cover=100 or ?weather_code=63
const params = new URLSearchParams(location.search);
const pretendKeys = ["visibility","cloud_cover","cloud_cover_low","precipitation","weather_code","wind_speed_10m","wind_direction_10m"]
  .filter(key => params.get(key) !== null && Number.isFinite(Number(params.get(key))));
const weatherPreview = pretendKeys.length ? Object.fromEntries(pretendKeys.map(key => [key, Number(params.get(key))])) : null;
const mapContainer = document.querySelector("#map");
function navigationBounds() {
  const {clientWidth,clientHeight} = mapContainer;
  if (!clientWidth || clientHeight <= clientWidth) return mapBounds;
  // A tall viewport needs room above and below the chart when the province fits its width.
  const latitudeMargin = Math.min(25, 5 * clientHeight / clientWidth);
  return [[mapBounds[0][0],mapBounds[0][1]-latitudeMargin],
    [mapBounds[1][0],mapBounds[1][1]+latitudeMargin]];
}
// In priority order. Zoom bands keep the regional names separate from
const showcasePlaces = [
  ["Sambro Harbour", [-63.615,44.480], 11.5, Infinity, "major"],
  ["Sambro Ledges", [-63.574,44.469], 11.5, Infinity, "water"],
  ["Sambro Island", [-63.563,44.432], 11.5, Infinity, "major", {anchor:"top-right", offset:[-4,5]}],
  ["Sable Island", [-59.910,43.920], 8.4, Infinity, "major"],
  ["West End", [-60.023,43.932], 8.4, Infinity, "minor", {anchor:"bottom",offset:[0,-8]}],
  ["East End", [-59.791,43.960], 8.4, Infinity, "minor", {anchor:"bottom",offset:[0,-8]}],
];

const tourState = {active:false, night:null, finished:false};
const atlas = await createAtlas({
  read, shorelineOptions:requestOptions, initialLayers:preferences.layers,
  sweepsPath:"/sweeps.json", weatherPreview, detailImage:"/relief-detail.webp",
  bounds:navigationBounds, minZoom:4.5, tour:tourState, showcasePlaces,
  describeShips(snapshot, points, fresh, lastHeard) {
    const status = ({
      live:snapshot.refresh ? "AIS live" : "AIS snapshot", stale:"AIS snapshot · stale", waiting:"Waiting for ships",
      offline:"Ships temporarily unavailable", "not-configured":"Ships not configured",
    })[snapshot.status] || "Ships temporarily unavailable";
    return points.length || snapshot.status === "live" ? `${status} · ${fresh} fresh · ${lastHeard} last heard` : status;
  },
  cardFrame() {
    const bottom = recordTour ? innerHeight - document.querySelector("#credits").offsetHeight - 24 : document.querySelector("#dock").offsetTop;
    return {minimum:8, margin:8, bottom};
  },
  onNight(night) {
    modeControl.classList.toggle("is-night", night);
    modeControl.title = night ? "Switch to chart mode" : "Switch to night mode";
    modeControl.setAttribute("aria-label", modeControl.title);
  },
});
const {map, status, applySettings, clearHover, inspect, highlight, showCard,
  setNight, isDark, updateShips, updateWeather, updateBuoys} = atlas;

map.on("resize", () => map.setMaxBounds(navigationBounds()));
function overviewCamera() {
  return map.cameraForBounds(overview, {
    padding:{top:24,bottom:30,left:16,right:16}, bearing:BEARING,
  });
}
function applyOverview(duration = 0) {
  const camera = overviewCamera();
  if (camera) map.easeTo({...camera, duration});
}

let tourAbort, suppressTourClick = false;
const simulatedWeather = document.querySelector("#simulated-weather");
const recordTour = params.get("tour") === "record";
const tourEase = t => t*t*(3-2*t);
const clearWeather = {visibility:30000, cloud_cover:0, cloud_cover_low:0, weather_code:0, precipitation:0};
const viewControl = document.querySelector("#view");
const modeControl = document.querySelector("#mode");
const layerControls = document.querySelector("#layers fieldset");
const tourControl = document.querySelector("#tour");

const presets = {
  "halifax": () => map.easeTo({center:[-63.565,44.655], zoom:11.70, duration:450}),
  "halifax-coast": () => map.easeTo({center:[-63.616,44.569], zoom:10.85, duration:450}),
  "nova-scotia": () => applyOverview(450),
};
function savePreferences() {
  try { localStorage.setItem(storageKey, JSON.stringify(preferences)); } catch {}
}

function showSimulatedWeather(visible) {
  simulatedWeather.hidden = !visible;
  atlas.setSimulatedWeather(visible);
}

function endTour() {
  if (!tourState.active) return;
  tourAbort.abort();
  tourState.active = false;
  tourState.finished = false;
  tourState.night = null;
  map.stop();
  clearHover();
  map.getCanvas().style.cursor = "";
  atlas.endTourWeather();
  showSimulatedWeather(false);
  document.body.classList.remove("touring");
  tourControl.textContent = "Tour";
  applySettings(preferences);
  renderShips();
}

function pauseTour(ms, signal) {
  return new Promise(resolve => {
    const finish = () => {
      clearTimeout(timer);
      signal.removeEventListener("abort", finish);
      resolve(!signal.aborted);
    };
    const timer = setTimeout(finish, ms);
    signal.addEventListener("abort", finish, {once:true});
  });
}

function inspectTourSubject(layer, id, coordinates, properties) {
  const point = map.project(coordinates);
  if (layer === "lights") point.x += 180;   // leave the entire sweep visible beside the lighthouse card
  inspect({type:"mousemove", point},
    {layer:{id:layer}, id, geometry:{coordinates}, properties});
}

function spotlight(p, ferry) {
  if (!ferry) {
    inspectTourSubject("vessels", p.mmsi, [p.lon,p.lat], {mmsi:p.mmsi});
    return;
  }
  highlight({layer:{id:"vessels"}, id:p.mmsi, geometry:{coordinates:[p.lon,p.lat]}});
  const underway = (p.speed ?? 0) >= .5;
  showCard(p.name, ["Halifax Transit ferry", underway ? `Last reported under way · ${p.speed.toFixed(1)} kn` : "Last reported stopped"],
    map.project([p.lon,p.lat]));
}

async function tour() {
  if (tourState.active) {
    const replay = tourState.finished;
    endTour();
    if (!replay) return;
  }
  atlas.beginTourWeather(clearWeather);
  tourState.active = true;
  tourAbort = new AbortController();
  const {signal} = tourAbort;
  tourState.night = false;
  document.body.classList.add("touring");
  document.querySelector("#layers").open = false;
  tourControl.textContent = "Stop tour";
  viewControl.value = "custom";
  applySettings({...preferences, layers:{...preferences.layers, ships:true, seamarks:true,
    lights:true, labels:true, fog:true, sky:true, rain:false, spotlight:false}});
  renderShips();
  const reducedMotion = matchMedia("(prefers-reduced-motion: reduce)").matches;
  const portrait = innerWidth < 600 && innerHeight > innerWidth;
  const pause = ms => pauseTour(ms, signal);
  const move = (camera, duration, curve) => new Promise(resolve => {
    const finish = () => {
      map.off("moveend", finish);
      signal.removeEventListener("abort", finish);
      resolve(!signal.aborted);
    };
    signal.addEventListener("abort", finish, {once:true});
    map.on("moveend", finish);
    map[curve ? "flyTo" : "easeTo"]({...camera, duration:reducedMotion ? 0 : duration,
      easing:tourEase, ...(curve ? {curve} : {})});
    if (!map.isMoving()) finish();
  });
  const peggysId = atlas.lights.findIndex(light => /peggys point/i.test(light.name));
  const peggys = atlas.lights[peggysId];
  const buoy = atlas.marks.find(f => aidName(f.properties) === "HS19" && f.properties.lit);
  const harbour = [-63.565,44.655];
  const sambro = {center:portrait ? [-63.5805,44.458] : [-63.579,44.458], zoom:portrait ? 12.78 : 13.12};
  if (!await move(overviewCamera(), 1400) || !await pause(1300)) return;

  const vessels = [...atlas.ships.values()].filter(p => Number.isFinite(p.lon) && Number.isFinite(p.lat) &&
    p.lon >= -63.66 && p.lon <= -63.49 && p.lat >= 44.56 && p.lat <= 44.73);
  const ferry = vessels.filter(p => p.age <= freshAge && /^(RITA JOE|CHRISTOPHER STANNIX)\b/i.test(p.name || ""))
    .sort((a,b) => (b.speed >= .5) - (a.speed >= .5) || a.age-b.age)[0];
  const ship = ferry || biggestInHarbour(vessels.filter(p => p.age <= freshAge));
  if (!await move({center:ship ? [ship.lon,ship.lat] : harbour, zoom:portrait ? 12.55 : 12.95}, 7400, 1.35)) return;
  if (ship) spotlight(ship, Boolean(ferry));
  if (!await pause(3820)) return;

  clearHover();
  tourState.night = true;
  setNight(true);
  if (!await pause(5000)) return;

  if (!await move({center:peggys?.coordinates || [-63.919,44.492], zoom:portrait ? 13.25 : 13.65}, 4200, 1.15)) return;
  if (peggys) inspectTourSubject("lights", peggysId, peggys.coordinates, {id:peggysId, open:atlas.openSources});
  if (!await pause(3760)) return;

  if (!await move({...sambro, zoom:portrait ? 11.95 : 12.3}, 4400, 1.15) ||
      !await pause(800) || !await move(sambro, 2900) || !await pause(700)) return;
  if (buoy) inspectTourSubject("marks", buoy.id, buoy.geometry.coordinates, buoy.properties);
  if (!await pause(3120)) return;

  clearHover();
  showSimulatedWeather(true);
  atlas.setTourPreview({...clearWeather, visibility:100, weather_code:45, cloud_cover:65, cloud_cover_low:65});
  if (!await pause(3400)) return;
  atlas.setTourPreview(clearWeather);
  if (!await pause(3600)) return;
  showSimulatedWeather(false);

  if (!await move(overviewCamera(), 5100, 1.25) || !await pause(3860)) return;

  // Hold the final scene: restoring the visitor's layers here would blink. Any interaction restores them.
  preferences.mode = "night";
  savePreferences();
  tourState.finished = true;
  document.body.classList.remove("touring");
  tourControl.textContent = "Tour";
  viewControl.value = "nova-scotia";
}

function bindControls() {
  viewControl.disabled = modeControl.disabled = layerControls.disabled = tourControl.disabled = false;
  viewControl.value = preferences.view;
  const names = {ships:"Ships",ghosts:"Estimated positions",buoys:"Weather buoys",seamarks:"Seamarks",
    lights:"Lighthouses",openSources:"Open sources only",weather:"Halifax weather",fog:"Fog",sky:"Cloud and moonlight",rain:"Rain and snow",spotlight:"Ship of the night",labels:"Place names"};
  for (const [id, name] of Object.entries(names)) {
    const label = document.createElement("label");
    const input = document.createElement("input");
    input.type = "checkbox";
    input.checked = preferences.layers[id];
    input.addEventListener("change", () => {
      preferences.layers[id] = input.checked;
      savePreferences();
      clearHover();
      applySettings(preferences);
      renderShips();
    });
    label.append(input, document.createTextNode(name));
    layerControls.append(label);
  }
  document.addEventListener("pointerdown", event => {
    suppressTourClick = tourState.active && !tourState.finished && map.getContainer().contains(event.target);
    if (!tourControl.contains(event.target)) endTour();
  }, true);
  document.addEventListener("click", event => {
    if (!tourControl.contains(event.target)) endTour();
  }, true);
  document.addEventListener("wheel", endTour, {capture:true, passive:true});
  document.addEventListener("keydown", event => {
    if (tourState.active && tourControl.contains(event.target) && [" ", "Enter"].includes(event.key)) return;
    endTour();
  }, true);
  document.addEventListener("change", endTour, true);
  viewControl.addEventListener("change", () => {
    endTour();
    preferences.view = viewControl.value;
    savePreferences();
    presets[preferences.view]();
  });
  map.on("movestart", event => {
    if (event.originalEvent) { endTour(); viewControl.value = "custom"; }
  });
  modeControl.addEventListener("click", () => {
    const target = !atlas.night;
    endTour();
    map.stop();
    // Choosing what daylight would show anyway goes back to following sunrise and sunset.
    preferences.mode = target === isDark(Date.now()/1000) ? "auto" : target ? "night" : "chart";
    savePreferences();
    applySettings(preferences);
  });
  tourControl.addEventListener("click", tour);
}

const weatherURL = "https://api.open-meteo.com/v1/forecast?latitude=44.65&longitude=-63.58"
  + "&current=temperature_2m,apparent_temperature,weather_code,wind_speed_10m,wind_direction_10m,"
  + "wind_gusts_10m,precipitation,visibility,cloud_cover,cloud_cover_low&wind_speed_unit=kn&timezone=America%2FHalifax";
async function refreshWeather() {
  try { updateWeather((await read(weatherURL)).current); } catch { /* Keep last good reading. */ }
}
let buoyRetry;
async function refreshBuoys() {
  clearTimeout(buoyRetry);
  try { updateBuoys((await read("/api/buoys")).stations); }
  catch { buoyRetry = setTimeout(() => { if (!document.hidden) refreshBuoys(); }, 90000); }   // keep last good readings
}

let shipSnapshot = null, shipSnapshotAt = 0, shipRefreshTimer, fetchingShips = false;
function renderShips() {
  if (!shipSnapshot) return;
  const elapsed = Math.max(0, Math.floor((Date.now()-shipSnapshotAt)/1000));
  updateShips({...shipSnapshot, points:shipSnapshot.points
    .map(p => ({...p,age:p.age+elapsed})).filter(p => p.age < 7*86400)});
}
async function refreshShips() {
  shipRefreshTimer = null;
  if (document.hidden || fetchingShips) return;
  fetchingShips = true;
  try {
    shipSnapshot = await read("/api/ships");
    const responseAge = Number(shipSnapshot.asOf);
    shipSnapshotAt = Number.isFinite(responseAge) && responseAge > 0 ? responseAge : Date.now();
    renderShips();
  } catch {
    if (shipSnapshot) {
      shipSnapshot.status = "stale";
      renderShips();
    } else status.textContent = "Ships temporarily unavailable";
  } finally {
    fetchingShips = false;
    shipRefreshTimer = setTimeout(refreshShips, (shipSnapshot?.refresh || (shipSnapshot?.status === "waiting" ? 20 : 60))*1000);
  }
}
function pollWhileVisible(callback, interval) {
  const refresh = () => { if (!document.hidden) callback(); };
  refresh();
  setInterval(refresh, interval);
}

map.on("mousemove", event => {
  const {movementX, movementY} = event.originalEvent || {};
  if (tourState.active && (movementX || movementY)) { endTour(); return; }
  if (!tourState.active) inspect(event);
});
map.on("click", event => {
  if (!suppressTourClick && !tourState.active) inspect(event);
});
const canvas = map.getCanvas();
canvas.addEventListener("pointerleave", event => {
  if (!tourState.active && event.pointerType === "mouse") clearHover();
});
let touchStart;
canvas.addEventListener("touchstart", event => {
  touchStart = event.touches.length === 1 ? event.touches[0] : null;
}, {passive:true});
canvas.addEventListener("touchend", event => {
  const touch = event.changedTouches[0];
  const start = touchStart;
  touchStart = null;
  if (suppressTourClick || !start || event.touches.length || !touch || touch.identifier !== start.identifier ||
      Math.hypot(touch.clientX-start.clientX,touch.clientY-start.clientY) > 12) return;
  const frame = canvas.getBoundingClientRect();
  if (!tourState.active) inspect({type:"touch",point:{x:touch.clientX-frame.left,y:touch.clientY-frame.top}});
}, {passive:true});
canvas.addEventListener("touchcancel", () => { touchStart = null; }, {passive:true});
map.once("load", () => {
  bindControls();
  presets[preferences.view]();
  applySettings(preferences);
  const preview = new URLSearchParams(location.search).has("static");
  const credits = document.querySelector("#credits");
  new ResizeObserver(() => document.documentElement.style.setProperty("--credits-height", credits.offsetHeight+"px")).observe(credits);
  let firstShips;
  if (preview) status.textContent = "Ships not configured";
  else {
    firstShips = refreshShips();
    document.addEventListener("visibilitychange", () => {
      if (!document.hidden && !shipRefreshTimer) refreshShips();
    });
    pollWhileVisible(refreshBuoys,1800000);
  }
  pollWhileVisible(refreshWeather,900000);
  pollWhileVisible(renderShips,10000);
  setInterval(() => { if (!tourState.active) applySettings(preferences); },30000);
  map.on("moveend",renderShips);
  if (recordTour) {
    document.body.classList.add("record-tour");
    const initialTour = tourAbort;
    map.once("idle", async () => {
      await Promise.race([firstShips || Promise.resolve(), new Promise(resolve => setTimeout(resolve, 1800))]);
      if (tourAbort === initialTour) tour();
    });
  }
});
// Phone extras: the collapsed credits and the "turn your phone" note.
const creditsToggle = document.querySelector("#credits-toggle");
creditsToggle.addEventListener("click", () => {
  const open = document.querySelector("#credits").classList.toggle("open");
  creditsToggle.setAttribute("aria-expanded", String(open));
  creditsToggle.textContent = open ? "Close" : "Credits";
});
const rotateNote = document.querySelector("#rotate");
let rotateDismissed = false;
try { rotateDismissed = sessionStorage.getItem("night-atlas.rotate") === "dismissed"; } catch {}
rotateNote.hidden = rotateDismissed;
rotateNote.querySelector("button").addEventListener("click", () => {
  rotateNote.hidden = true;
  try { sessionStorage.setItem("night-atlas.rotate", "dismissed"); } catch {}
});
