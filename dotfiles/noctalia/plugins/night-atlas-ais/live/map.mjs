import {BEARING, createAtlas, freshAge, jsonReader, mapBounds, overview} from "./atlas-core.mjs";

const requestOptions = () => ({cache:"no-store"});
const read = jsonReader(requestOptions);
const tourState = {active:false, night:null};
const atlas = await createAtlas({
  read, shorelineOptions:requestOptions, extraLinesPath:"/tss-traced.json",
  detailImage:"/relief-detail.jpg", bounds:() => mapBounds, minZoom:6.1, deferMarks:true,
  marksAttribution:"Lights and aid data: Canadian Coast Guard (unofficial, non-commercial)",
  tour:tourState, hideCardOnMiss:true,
  describeShips(snapshot, points, fresh, lastHeard) {
    const label = snapshot.status === "live" ? "AIS live" : "AIS reconnecting";
    return `${label} · ${fresh} fresh · ${lastHeard} last heard`;
  },
  cardFrame:() => ({minimum:-Infinity, margin:12, bottom:innerHeight}),
  onNight:night => console.info(`Night Atlas ${night ? "night" : "chart"} mode`),
  wantNight,
});
const {map, status, applySettings, classifySweeps, clearHover, inspect, showCard, highlight,
  setNight, updateBuoys, updateWeather, updateShips} = atlas;
let paused = false, commandId = null, viewportTimer, overrideRevision = "";

function applyOverview(duration = 0) {
  const camera = map.cameraForBounds(overview, {padding:{top:38,bottom:42,left:52,right:52},bearing:-5});
  if (!camera) return;
  map.easeTo({...camera, zoom:camera.zoom+.08, offset:[-108,-39], duration});
}

function reportViewport() {
  clearTimeout(viewportTimer);
  if (paused || !atlas.loaded) return;
  viewportTimer = setTimeout(() => {
    const b = map.getBounds();
    fetch("/viewport", {method:"POST", headers:{"Content-Type":"application/json"},
      body:JSON.stringify([b.getWest(),b.getSouth(),b.getEast(),b.getNorth()])}).catch(() => {});
  }, 850);
}

function wantNight(settings, now, isDark) {
  // A manual choice from the anchor menu holds until the next sunrise/sunset (or 24 h).
  const base = settings.mode === "night" || (settings.mode === "auto" && isDark(now));
  const o = settings.override;
  if (o && typeof o.at === "number" && now - o.at < 86400 && isDark(o.at) === isDark(now)) {
    if (o.mode === "toggle") return !base;          // right-click on the anchor: flip what's showing
    if (o.mode === "night" || o.mode === "chart") return o.mode === "night";
  }
  return base;
}

map.on("mousemove", event => inspect({type:"mousemove", point:event.point}));
map.getCanvas().addEventListener("mouseleave", clearHover);
map.on("moveend", reportViewport);
map.on("resize", reportViewport);

// View presets. Each reports itself as the active preset once its move ends; any move the user
// starts (drag, scroll) clears it. The anchor menu highlights the active one.
// ── Demo tour: a scripted fly-through for screen recordings ({view:"tour"}). Camera moves run
// inside MapLibre (full frame rate), and "hovers" are synthetic mousemove events at a feature, so
// the same info cards appear as with a real pointer. Any user drag ends nothing; it just plays.
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
function glide(camera, kind = "fly") {
  return new Promise(resolve => {
    map.once("moveend", resolve);
    (kind === "fly" ? map.flyTo : map.easeTo).call(map, {...camera, essential:true});
  });
}
function hoverAt(lngLat) {
  const point = map.project(lngLat);
  map.fire("mousemove", {point, lngLat:map.unproject(point), originalEvent:null});
}
const ferries = /^(RITA JOE|CHRISTOPHER STANNIX)\b/i;
// Ring and card for one named vessel, whatever else is moored on top of it.
function spotlight(p) {
  highlight({layer:{id:"vessels"}, id:p.mmsi, geometry:{coordinates:[p.lon,p.lat]}});
  const name = p.name.toLowerCase().replace(/\b\w/g, c => c.toUpperCase());
  showCard(name, ["Halifax Transit ferry", p.speed >= .5 ? `Under way · ${p.speed.toFixed(1)} kn` : "At the terminal"],
    map.project([p.lon,p.lat]));
}
async function tour() {
  if (tourState.active) return;
  tourState.active = true;
  reportPreset(null);
  try {
    const camera = map.cameraForBounds(overview, {padding:{top:38,bottom:42,left:52,right:52}, bearing:BEARING});
    map.jumpTo({...camera, zoom:camera.zoom+.08});
    await wait(3000);                                                    // 1. the whole chart, lights going
    const peggys = () => atlas.lights.find(l => /peggy/i.test(l.name))?.coordinates;
    const center = peggys();
    if (center) {
      await glide({center, zoom:12.6, duration:5500, curve:1.3});   // 2. Peggys Point
      await wait(600);
      const target = peggys();
      if (target) hoverAt(target);
      await wait(2800); clearHover();
    }
    await glide({center:[-63.48,44.52], zoom:10.6, duration:4200}, "ease");          // 3. Halifax approaches
    await wait(500); hoverAt([-63.40,44.50]); await wait(2600); clearHover();       //    weather buoy card
    // 4. into the harbour, to a Halifax ferry if one is on the air (a moving one first)
    const ferry = [...atlas.ships.values()].filter(p => p.age <= freshAge && ferries.test(p.name || ""))
      .sort((a,b) => /STANNIX/i.test(b.name) - /STANNIX/i.test(a.name))[0];   // Stannix first
    await glide({center:ferry ? [ferry.lon,ferry.lat] : [-63.565,44.635], zoom:ferry ? 13.4 : 12.4, duration:3600}, "ease");
    await wait(500);
    if (ferry) {
      for (let i=0; i<8; ++i) { spotlight(atlas.ships.get(ferry.mmsi) || ferry); await wait(500); }   // card follows it
      clearHover();
    } else {
      const view = map.getBounds(), centre = map.getCenter();
      const ship = [...atlas.ships.values()].filter(p => p.age <= freshAge && view.contains([p.lon,p.lat]))
        .sort((a,b) => Math.hypot(a.lon-centre.lng,a.lat-centre.lat) - Math.hypot(b.lon-centre.lng,b.lat-centre.lat))[0];
      if (ship) { hoverAt([ship.lon, ship.lat]); await wait(2600); clearHover(); }
    }
    tourState.night = true; setNight(true); await wait(2400);                   // 5. night mode, slow drift
    await glide({center:[-63.52,44.60], zoom:11.6, duration:4500}, "ease");
    await wait(600);                                                     //    (stays dark from here on)
    await glide({...camera, zoom:camera.zoom+.08, duration:5200, curve:1.2});    // 6. back out
    reportPreset("nova-scotia");
    await wait(2500);                                                    // 7. hold on the dark province
  } finally {
    tourState.active = false; tourState.night = null;
  }
}
window.atlasTour = tour;

const presets = {
  "halifax": () => map.easeTo({center:[-63.454,44.657], zoom:11.70, duration:450}),
  "halifax-coast": () => map.easeTo({center:[-63.616,44.569], zoom:10.85, duration:450}),
  "nova-scotia": () => applyOverview(450),
};
let pendingPreset = null, reportedPreset;
function reportPreset(name) {
  if (name === reportedPreset) return;
  reportedPreset = name;
  fetch("/preset", {method:"POST", headers:{"Content-Type":"application/json"}, body:JSON.stringify(name)}).catch(() => {});
}
map.on("movestart", event => { if (event.originalEvent) { pendingPreset = null; reportPreset(null); } });
map.on("moveend", () => { if (pendingPreset) { reportPreset(pendingPreset); pendingPreset = null; } });

function runCommand(command) {
  if (!command || command.id === commandId) return;
  commandId = command.id;
  if (command.view === "tour") { tour(); return; }
  if (presets[command.view]) {
    pendingPreset = command.view;
    presets[command.view]();
  } else if (command.view === "camera" && Array.isArray(command.center)) {   // tests / custom shortcuts
    reportPreset(null);
    map.jumpTo({center:command.center, zoom:command.zoom ?? map.getZoom()});
  }
}

// Commands are polled fast and separately from the heavier /state so presets react immediately.
setInterval(async () => {
  if (!atlas.loaded || paused) return;
  try { runCommand(await read("/command")); } catch {}
}, 150);

async function state() {
  if (!atlas.loaded || paused) return;
  try {
    const snapshot=await read("/state");
    runCommand(snapshot.command);
    const settings = snapshot.sweeps || {};
    const revision = JSON.stringify(settings);
    if (revision !== overrideRevision) {
      overrideRevision = revision;
      classifySweeps(settings);
    }
    applySettings(snapshot.settings);
    atlas.setWeatherPreview(snapshot.settings?.weatherPreview);
    updateBuoys(snapshot.buoys || []);
    updateWeather(snapshot.weather);
    updateShips(snapshot.ships);
  } catch (error) {
    status.textContent = "AIS snapshot unavailable";
  }
}
setInterval(state,1100);
let pausedCamera = null;
window.setAtlasPaused = value => {
  paused = value;
  if (paused) {
    pausedCamera = {center:map.getCenter(), zoom:map.getZoom()};
    map.stop();
    clearHover();
    clearTimeout(viewportTimer);
    atlas.setPaused(true);
  } else {
    map.resize();
    if (pausedCamera) map.jumpTo(pausedCamera);       // come back exactly where you left it
    atlas.setPaused(false);
    reportViewport();
    state();
  }
};

map.once("load", () => {
  applyOverview();
  reportPreset("nova-scotia");
  reportViewport();
  state();
});
