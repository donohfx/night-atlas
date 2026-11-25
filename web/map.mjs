import {Map as AtlasMap, Marker, setWorkerUrl} from "./vendor/maplibre-gl.mjs";
import {createExtras} from "./atlas-extras.mjs";

setWorkerUrl(new URL("./vendor/maplibre-gl-worker.mjs", import.meta.url).href);

const collection = (features = []) => ({type: "FeatureCollection", features});
const point = (coordinates, properties, id) => ({type: "Feature", id, geometry: {type: "Point", coordinates}, properties});
const read = async path => {
  const response = await fetch(path, {signal: AbortSignal.timeout(30000)});
  if (!response.ok) throw new Error(`${path} returned ${response.status}`);
  return response.json();
};
const [chart, colors, sweeps] = await Promise.all([read("/chart-data.json"), read("/palette.json"), read("/sweeps.json")]);
const palette = colors.dark;
// Pretend weather for a look on a fine day, e.g. ?visibility=300&cloud_cover=100 or ?weather_code=63
const params = new URLSearchParams(location.search);
const pretendKeys = ["visibility","cloud_cover","cloud_cover_low","precipitation","weather_code","wind_speed_10m","wind_direction_10m"]
  .filter(key => params.get(key) !== null && Number.isFinite(Number(params.get(key))));
const weatherPreview = pretendKeys.length ? Object.fromEntries(pretendKeys.map(key => [key, Number(params.get(key))])) : null;
const [marksData, aidsData] = await Promise.all([
  read("/seamarks.json").catch(() => collection()),
  read("/aids.json").catch(() => collection()),
]);
const isMark = f => f.geometry.type === "Point" && ["buoy","beacon"].includes(f.properties.k);
const aidName = p => (p.ref || p.n || "").toUpperCase().replaceAll(/[^A-Z0-9]/g, "");
const coastGuardBuoys = new Map();
for (const aid of aidsData.features) {
  const name = aidName(aid.properties);
  if (aid.properties.k !== "buoy" || !name) continue;
  if (!coastGuardBuoys.has(name)) coastGuardBuoys.set(name, []);
  coastGuardBuoys.get(name).push(aid.geometry.coordinates);
}
const duplicateBuoy = f => f.properties.k === "buoy" &&
  coastGuardBuoys.get(aidName(f.properties))?.some(([x,y]) =>
    Math.hypot(x - f.geometry.coordinates[0], y - f.geometry.coordinates[1]) < .001);
const markFeatures = [...marksData.features.filter(f => isMark(f) && !duplicateBuoy(f)), ...aidsData.features].map((f, id) => {
  const p = f.properties;
  return {...f, id, properties:{...p, icon:`mk-${p.k}-${p.s || "pillar"}-${p.cs || p.c || "-"}-${p.pat || ""}`}};
});
const chartLines = marksData.features.filter(f => !isMark(f));
for (const [css, field] of Object.entries({ink:"surface", paper:"on_surface", muted:"on_surface_variant",
                                          border:"outline_variant", accent:"primary"})) {
  document.documentElement.style.setProperty(`--${css}`, palette[field]);
}

const lightColors = {W:"#f0eedc", R:"#f36c64", G:"#6adca1", Y:"#efce6a"};
const lightFeatures = chart.lights.map((light, id) => point(light.coordinates, {
  id, color:lightColors[light.colors[0]] || "#83948a",
  alt:lightColors[light.colors[1]] || "", third:lightColors[light.colors[2]] || "",
  verified: light.colors.length > 0, fixed:light.character === "F", rear:/\brear\b/i.test(light.name),
}, id));
const [west, south, east, north] = chart.reliefBounds;
const imageCorners = [[west,north],[east,north],[east,south],[west,south]];
const mapBounds = [[-68.85, 42.99], [-56.30, 47.58]];
const overview = [[-66.70, 43.22], [-57.60, 47.38]];
// In priority order. Zoom bands keep the regional names separate from
// neighbourhood and harbour labels as the camera moves closer.
// [name, [lon,lat], minZoom, maxZoom, kind, marker options]. Point places (cities) sit beside
// their location over land rather than on top of the harbour's lights and ships.
const places = [
  ["Nova Scotia", [-63.07,45.00], 6.2, 9.9, "region"],
  ["Halifax", [-63.590,44.652], 6.69, Infinity, "major", {anchor:"right", offset:[-10,0]}],
  ["Cape Breton", [-60.74,46.22], 6.2, 10.3, "major"],
  ["Bay of Fundy", [-65.82,45.15], 7.3, 10.5, "water"],
  ["Dartmouth", [-63.554,44.673], 10.7, Infinity, "major", {anchor:"left", offset:[10,0]}],
  ["Bedford Basin", [-63.648,44.706], 11.4, Infinity, "water"],
  ["McNabs Island", [-63.529,44.608], 12.0, Infinity, "minor"],
  ["Northwest Arm", [-63.600,44.626], 12.4, Infinity, "water"],
  ["The Narrows", [-63.590,44.668], 13.0, Infinity, "water"],
];
const labels = [];
const freshAge = 1200;
const marksZoom = 9.2;
const allMarksZoom = 10.5;
const visibleMarks = ["step", ["zoom"], ["!", ["has","ll"]], allMarksZoom, true];
const activeLight = ["coalesce", ["feature-state","lit"], 1];
const seaTint = "#102122";
const detailOpacity = ["interpolate",["linear"],["zoom"],7.9,0,8.5,1];   // vector land in before raster steps show (from 7.9: z7 tiles exceed 65k vertices)
const inland = ["!=",["get","class"],"ocean"];

const map = new AtlasMap({
  container: "map",
  center: [-63.65,45.2], zoom: 6.70, bearing: -5, pitch: 0,
  minZoom: 4.5, maxZoom: 16.5, maxBounds: mapBounds, maxCanvasSize:[5120,4096],
  dragRotate:false, pitchWithRotate:false, renderWorldCopies:false, attributionControl:false,
  fadeDuration:160,
  style: {
    version: 8,
    glyphs: "https://tiles.openfreemap.org/fonts/{fontstack}/{range}.pbf",
    transition: {duration: 1100, delay: 0},
    sources: {
      relief: {type:"image", url:"/relief.jpg", coordinates:imageCorners},
      close: {type:"image", url:"/relief-detail.jpg", coordinates:imageCorners},
      osm: {type:"vector", url:"https://tiles.openfreemap.org/planet/latest", bounds:[west,south,east,north]},
      land:{type:"geojson",data:"/land.json",tolerance:.4,maxzoom:15},
      contours:{type:"geojson", data:"/contours.json"},
      lights:{type:"geojson", data:collection(lightFeatures)},
      ships:{type:"geojson", data:collection()},
      vectors:{type:"geojson", data:collection()},
      hover:{type:"geojson", data:collection()},
      seamarks:{type:"geojson", data:collection(chartLines)},
      marks:{type:"geojson", data:collection(markFeatures)},
      buoys:{type:"geojson", data:collection()},
      ghosts:{type:"geojson", data:collection()},
    },
    layers: [
      {id:"deep", type:"background", paint:{"background-color":"#0b1414"}},
      {id:"relief", type:"raster", source:"relief", paint:{"raster-fade-duration":0}},
      {id:"water-depth-shading", type:"raster", source:"close", minzoom:7.9,
        paint:{"raster-opacity":detailOpacity,"raster-fade-duration":0}},
      {id:"land-fill",type:"fill",source:"land",minzoom:7.9,
        paint:{"fill-color":"#23352e","fill-opacity":detailOpacity}},
      {id:"fine-water", type:"fill", source:"osm", "source-layer":"water", minzoom:9.0, filter:inland,
        paint:{"fill-color":seaTint,"fill-opacity":["interpolate",["linear"],["zoom"],9,0,11,.96]}},
      {id:"coastline",type:"line",source:"land",minzoom:7.9,
        paint:{"line-color":"#687f70","line-opacity":["interpolate",["linear"],["zoom"],7.9,0,8.5,.5,11,.64],
          "line-width":["interpolate",["linear"],["zoom"],9,.5,15,1.05]}},
      {id:"fine-shoreline", type:"line", source:"osm", "source-layer":"water", minzoom:10, filter:inland,
        paint:{"line-color":"#526d62","line-opacity":["interpolate",["linear"],["zoom"],10,0,12,.64],
          "line-width":["interpolate",["linear"],["zoom"],10,.42,15,.85]}},
      {id:"waterways", type:"line", source:"osm", "source-layer":"waterway", minzoom:12,
        paint:{"line-color":"#41635d","line-opacity":.62,"line-width":["interpolate",["linear"],["zoom"],12,.45,16,1.35]}},
      {id:"bathymetry", type:"line", source:"contours", minzoom:8.5,
        paint:{"line-color":"#567a71","line-width":["case",["get","major"],.8,.5],
          "line-opacity":["interpolate",["linear"],["zoom"],8.5,0,10,.43,14,.28]}},
      {id:"tss-zone", type:"fill", source:"seamarks", filter:["==",["get","k"],"separation_zone"],
        paint:{"fill-color":"#7d5f86","fill-opacity":.09}},
      {id:"tss-lines", type:"line", source:"seamarks", minzoom:6.8,
        filter:["in",["get","k"],["literal",["separation_line","separation_boundary","separation_lane"]]],
        paint:{"line-color":"#8d6f96","line-opacity":.34,"line-width":.8,"line-dasharray":[4,3]}},
      {id:"ferries", type:"line", source:"seamarks", filter:["==",["get","k"],"ferry"],
        paint:{"line-color":"#7f9a8e","line-opacity":["interpolate",["linear"],["zoom"],6,.2,10,.36],
          "line-width":.8,"line-dasharray":[2,3]}},
      {id:"mark-glow", type:"circle", source:"marks", minzoom:marksZoom, filter:["all",visibleMarks,["==",["get","lit"],1]],
        paint:{"circle-color":["match",["coalesce",["get","lc"],""],"R","#f36c64","G","#6adca1","Y","#efce6a","Bu","#84aaff","#f0eedc"],
          "circle-radius":["interpolate",["linear"],["zoom"],9.2,2,11,4.5,14,10],"circle-blur":.85,
          "circle-opacity":["*",["coalesce",["feature-state","lit"],1],.6]}},
      {id:"marks", type:"symbol", source:"marks", minzoom:marksZoom, filter:visibleMarks,
        layout:{"icon-image":["get","icon"],"icon-allow-overlap":true,"icon-ignore-placement":true,"icon-anchor":"bottom",
          "icon-size":["interpolate",["linear"],["zoom"],9.2,.28,11,.5,13,.95,15,1.15]},
        paint:{"icon-opacity":["interpolate",["linear"],["zoom"],9.2,0,10.4,.9]}},
      {id:"mark-labels", type:"symbol", source:"marks", minzoom:12.75, filter:["has","ref"],
        layout:{"text-field":["get","ref"],"text-font":["Noto Sans Regular"],"text-size":11,
          "text-anchor":"top","text-offset":[0,.25],"text-padding":2},
        paint:{"text-color":"#d8e6de","text-halo-color":"#0b1414","text-halo-width":1.2}},
      {id:"light-halo", type:"circle", source:"lights",
        // a rear range light sits almost on its front one: one halo until close enough to part them
        filter:["step",["zoom"],["all",["get","verified"],["!",["get","rear"]]],10,["get","verified"]],
        paint:{"circle-color":["get","color"],
          "circle-radius":["interpolate",["linear"],["zoom"],6.5,5,13,9],
          "circle-blur":.92,"circle-opacity":["*",activeLight,["case",["get","fixed"],.28,.42]]}},
      {id:"lights", type:"circle", source:"lights",
        paint:{"circle-color":["get","color"],
          "circle-radius":["interpolate",["linear"],["zoom"],6.5,["case",["get","verified"],1.65,1.05],
            13,["case",["get","verified"],2.8,1.55]],
          "circle-opacity":["case",["get","verified"],["*",activeLight,.91],.31]}},
      {id:"light-sector-2", type:"circle", source:"lights",filter:["!=",["get","alt"],""],
        paint:{"circle-color":["get","alt"],"circle-translate":[2.8,0],"circle-radius":1.45,
          "circle-opacity":["*",activeLight,.90]}},
      {id:"light-sector-3", type:"circle", source:"lights",filter:["!=",["get","third"],""],
        paint:{"circle-color":["get","third"],"circle-translate":[-2.8,0],"circle-radius":1.45,
          "circle-opacity":["*",activeLight,.90]}},
      {id:"course-vectors", type:"line", source:"vectors",
        paint:{"line-color":palette.secondary,"line-opacity":.63,"line-width":1.05}},
      {id:"vessels", type:"symbol", source:"ships",
        layout:{"icon-image":["get","symbol"],"icon-allow-overlap":true,
          "icon-rotate":["get","rotation"],"icon-rotation-alignment":"map",
          "icon-size":["interpolate",["linear"],["zoom"],6,1.05,9,.88,13,.74]},
        paint:{"icon-opacity":["get","opacity"]}},
      // Ships that left AIS coverage, dead-reckoned along their last course and fading out.
      {id:"ghost-trails", type:"line", source:"ghosts", filter:["==",["geometry-type"],"LineString"],
        paint:{"line-color":palette.secondary,"line-opacity":["get","opacity"],"line-width":.9,"line-dasharray":[1.2,2.4]}},
      {id:"ghosts", type:"symbol", source:"ghosts", filter:["==",["geometry-type"],"Point"],
        layout:{"icon-image":"ghost-arrow","icon-allow-overlap":true,"icon-rotate":["get","rotation"],
          "icon-rotation-alignment":"map","icon-size":["interpolate",["linear"],["zoom"],6,1.55,9,1.05,13,.78]},
        paint:{"icon-opacity":["get","opacity"]}},
      {id:"weather-buoys", type:"symbol", source:"buoys",
        layout:{"icon-image":"weather-buoy","icon-allow-overlap":true,"icon-anchor":"bottom",
          "icon-size":["interpolate",["linear"],["zoom"],6,.36,9,.6,12,1.0]},
        paint:{"icon-opacity":["interpolate",["linear"],["zoom"],6,["*",["get","opacity"],.6],9,["get","opacity"]]}},
      {id:"hover-ring",type:"circle",source:"hover",paint:{
        "circle-radius":9,"circle-color":"transparent","circle-stroke-color":palette.primary,
        "circle-stroke-width":1.15,"circle-stroke-opacity":.86}},
    ],
  },
});
map.touchZoomRotate.disableRotation();
map.keyboard.disableRotation();
const BEARING = -5;
map.on("rotate", () => { if (Math.abs(map.getBearing()-BEARING) > .01) map.setBearing(BEARING); });

const status = document.querySelector("#status");
const details = document.querySelector("#details");
let loaded = false, ships = new Map();
let shipRevision = "", statusText = "Waiting for ships", highlighted = null;
let buoyRevision = "", layersOn = {ships:true, ghosts:true, buoys:true, seamarks:true, lights:true, weather:true, fog:true, sky:true, rain:true, spotlight:true, labels:false};
let night = null, labelScale = 1, beamBoost = 1;
const ghostWindow = 7200;           // seconds a vessel keeps drifting after its last report
const ghosts = new Map();

function overviewCamera() {
  return map.cameraForBounds(overview, {
    padding:{top:24,bottom:30,left:16,right:16}, bearing:BEARING,
  });
}
function applyOverview(duration = 0) {
  const camera = overviewCamera();
  if (camera) map.easeTo({...camera, duration});
}

function timing(light) {
  if (!light.colors.length) return null;
  if (light.sequence.length) return light.sequence;
  const {period,character} = light;
  if (!(period > 0)) return null;
  if (character === "Iso") return [[period/2,true],[period/2,false]];
  if (character === "Oc") return [[period*.72,true],[period*.28,false]];
  if (character === "Mo" && light.group === "A") {
    const unit = Math.min(.45, period / 7);
    return [[unit,true],[unit,false],[3*unit,true],[period-5*unit,false]];
  }
  if (!["Fl","LFl","Q","VQ"].includes(character)) return null;
  const groups = /^\d+(?:\+\d+)*$/.test(light.group) ? light.group.split("+").map(Number) : [1];
  const total = groups.reduce((sum,count)=>sum+count,0);
  if (total < 1 || total > 12) return null;
  const on = Math.min(character === "LFl" ? 2 : .48, period/(3*total));
  const gap = Math.min(1.0, period/(3*total));
  const phases = [];
  for (const [index,count] of groups.entries()) {
    for (let i=0; i<count; ++i) {
      phases.push([on,true]);
      if (i<count-1) phases.push([gap,false]);
    }
    if (index<groups.length-1) phases.push([gap*1.8,false]);
  }
  phases.push([period-phases.reduce((sum,phase)=>sum+phase[0],0),false]);
  return phases;
}
const markRhythms = markFeatures.flatMap(f => {
  const p = f.properties;
  if (!p.lit) return [];
  const phases = timing({colors:[p.lc || "W"], character:p.lch, period:Number(p.lp), group:p.lg || "", sequence:p.seq || []});
  return phases ? [{id:f.id, phases, period:phases.reduce((n,q) => n+q[0],0), previous:null}] : [];
});
const rhythms = chart.lights.map((light,id) => {
  const phases = timing(light);
  return phases && {id, phases, period:phases.reduce((n,p) => n+p[0],0), previous:null};
}).filter(Boolean);

function illuminated(rhythm, now) {
  let phase = (now + rhythm.id*.618) % rhythm.period;
  for (const [length,on] of rhythm.phases) {
    if (phase < length) return on;
    phase -= length;
  }
  return false;
}

function blink() {
  if (!loaded || document.hidden) return;
  const now = Date.now()/1000;
  const view = map.getBounds();
  for (const rhythm of rhythms) {
    if (!view.contains(chart.lights[rhythm.id].coordinates)) continue;
    const lit = sweepIds.has(rhythm.id) || illuminated(rhythm,now) ? 1 : .08;
    if (lit !== rhythm.previous) {
      rhythm.previous = lit;
      map.setFeatureState({source:"lights",id:rhythm.id},{lit});
    }
  }
  if (map.getZoom() < marksZoom || !layersOn.seamarks) return;
  const showAllMarks = map.getZoom() >= allMarksZoom;
  for (const rhythm of markRhythms) {
    const mark = markFeatures[rhythm.id];
    if ((!showAllMarks && mark.properties.ll) || !view.contains(mark.geometry.coordinates)) continue;
    const lit = illuminated(rhythm,now) ? 1 : .05;
    if (lit !== rhythm.previous) {
      rhythm.previous = lit;
      map.setFeatureState({source:"marks",id:rhythm.id},{lit});
    }
  }
}
setInterval(blink,85);

const beamCanvas = document.createElement("canvas");
beamCanvas.className = "light-beams";
beamCanvas.setAttribute("aria-hidden","true");
map.getContainer().append(beamCanvas);
const beamContext = beamCanvas.getContext("2d");
const extras = createExtras({map, beamCanvas, accent:palette.primary, ships:() => ships.values(),
  preview:weatherPreview});
const rhythmById = new Map(rhythms.map(rhythm => [rhythm.id,rhythm]));
const flashing = new Set(["Fl","LFl","Q","VQ","UQ","IUQ","IVQ"]);
let sweepOverrides = new Map();
let sweeping = [], sweepIds = new Set();

function sweepKey(value) {
  const text = String(value || "").trim().toLowerCase();
  const reference = /^h?\s*0*(\d+(?:\.\d+)?)$/.exec(text);
  if (reference) return "h"+Number(reference[1]);
  return text.replace(/\s+(lighthouse|lightstation)$/,"").replaceAll(/[^a-z0-9]/g,"");
}

function classifySweeps(settings) {
  sweepOverrides = new Map(Object.entries(settings).map(([key,value])=>[sweepKey(key),value]));
  const byId = new Map(rhythms.map(rhythm=>[rhythm.id,rhythm]));
  sweeping = chart.lights.flatMap((light,id)=>{
    const choice = sweepOverrides.get(sweepKey(light.intl)) ?? sweepOverrides.get(sweepKey(light.name));
    const rhythm = byId.get(id);
    if (choice === false || !light.colors.length) return [];
    if (choice === true) return [rhythm || {id,period:1,phases:[[1,true]]}];
    const notable = /lighthouse|lightstation/i.test(light.name) && !/range|wharf|breakwater|museum/i.test(light.name);
    return rhythm && flashing.has(light.character) && light.range >= 8 && notable ? [rhythm] : [];
  });
  sweepIds = new Set(sweeping.map(rhythm => rhythm.id));
}
classifySweeps({});
let beamFrame = 0, lastBeam = 0;

function sectorColor(light,outgoing) {
  if (!light.sectors?.length) return light.colors[0];
  // CCG sector bearings point to the light as observed from seaward.
  const incoming = (outgoing+180)%360;
  for (const [color,start,end] of light.sectors) {
    const span = ((end-start)%360+360)%360 || 360;
    if (((incoming-start)%360+360)%360 < span) return color;
  }
  return null;
}

// Beams stop at the shore. For each sweeping light, rasterise the surrounding land once and
// walk outwards along every half degree to find how far (metres) the beam can travel.
const REACH = 30000, OWN_LAND = 250;     // metres; a light shines over its own rock or headland
const MASK = 2048, STEPS = 720;
const mercator = ([lon,lat]) => [(lon+180)/360, (1-Math.asinh(Math.tan(lat*Math.PI/180))/Math.PI)/2];
const metresPerUnit = lat => 40075016.7*Math.cos(lat*Math.PI/180);
let shores = null;
const reaches = new Map();
read("/land.json").then(land => {
  shores = land.features.flatMap(({geometry:g}) =>
    (g.type === "Polygon" ? [g.coordinates] : g.coordinates).map(rings => {
      const paths = rings.map(ring => ring.map(mercator));
      let west = 1, north = 1, east = 0, south = 0;
      for (const [x,y] of paths[0]) {
        west = Math.min(west,x); east = Math.max(east,x);
        north = Math.min(north,y); south = Math.max(south,y);
      }
      return {paths,west,north,east,south};
    }));
}).catch(error => console.warn("Night Atlas shoreline:", error.message));

function beamReach(light) {
  const [cx,cy] = mercator(light.coordinates);
  const unit = metresPerUnit(light.coordinates[1]), span = REACH/unit;
  const scale = MASK/(2*span), perPixel = unit/scale;
  const canvas = document.createElement("canvas");
  canvas.width = canvas.height = MASK;
  const context = canvas.getContext("2d",{willReadFrequently:true});
  context.beginPath();
  for (const shore of shores) {
    if (shore.east < cx-span || shore.west > cx+span || shore.south < cy-span || shore.north > cy+span) continue;
    for (const path of shore.paths) {
      for (const [i,[x,y]] of path.entries())
        context[i ? "lineTo" : "moveTo"]((x-cx)*scale+MASK/2, (y-cy)*scale+MASK/2);
      context.closePath();
    }
  }
  context.fill("evenodd");
  const pixels = context.getImageData(0,0,MASK,MASK).data;
  const first = Math.ceil(OWN_LAND/perPixel);
  return Float32Array.from({length:STEPS}, (_,step) => {
    const angle = step*2*Math.PI/STEPS, dx = Math.sin(angle), dy = -Math.cos(angle);
    for (let d = first; d < MASK/2; ++d) {
      const x = Math.floor(MASK/2+dx*d), y = Math.floor(MASK/2+dy*d);
      if (pixels[(y*MASK+x)*4+3] > 127) return d === first ? 0 : d*perPixel;
    }
    return REACH;
  });
}

function drawBeams(timestamp) {
  beamFrame = 0;
  if (!loaded || document.hidden) return;
  if (timestamp - lastBeam < (touring ? 0 : 32)) {      // every frame during the tour (smooth video)
    beamFrame = requestAnimationFrame(drawBeams);
    return;
  }
  lastBeam = timestamp;
  const width = map.getContainer().clientWidth, height = map.getContainer().clientHeight;
  const density = Math.min(1,devicePixelRatio);
  const pixelWidth = Math.round(width*density), pixelHeight = Math.round(height*density);
  if (beamCanvas.width!==pixelWidth || beamCanvas.height!==pixelHeight) {
    beamCanvas.width = pixelWidth;
    beamCanvas.height = pixelHeight;
  }
  beamContext.setTransform(density,0,0,density,0,0);
  beamContext.clearRect(0,0,width,height);
  const now = Date.now()/1000, zoom = map.getZoom(), bearing = map.getBearing();
  const bounds = map.getBounds();
  extras.setLayers(layersOn);
  extras.begin(width,height,density,now,night);
  const strength = Math.min(.32,.125+Math.max(0,zoom-7)*.031)*beamBoost*extras.strength();
  let toMeasure = 1;                      // at most one new shoreline mask per frame
  for (const rhythm of layersOn.lights ? sweeping : []) {
    const light = chart.lights[rhythm.id];
    if (!bounds.contains(light.coordinates)) continue;
    let reach = reaches.get(rhythm.id);
    if (!reach) {
      if (!shores || !toMeasure) continue;
      --toMeasure;
      reaches.set(rhythm.id, reach = beamReach(light));
    }
    // A turning lens: a beam passes any bearing once per charted period (that pass is what a
    // mariner sees as the flash), so the twin night lens turns at half the speed of the
    // single chart beam. Sectors still colour or hide it.
    const turns = beamBoost > 1 ? [0,180] : [0];
    const azimuth = (now*360/(Math.max(2.5, rhythm.period)*turns.length) + rhythm.id*37.3)%360;
    const center = map.project(light.coordinates);
    const length = Math.min(103,14 + (light.range || 8)*.65 + Math.max(0,zoom-7)*10)*(beamBoost > 1 ? 1.9 : 1)*(1+(extras.strength()-1)*.2);
    const pixelsPerMetre = 512*2**zoom/metresPerUnit(light.coordinates[1]);
    const wedges = (beamBoost > 1 ? [[10,.30],[6,.34],[2.8,.42]] : [[9,1]])   // night: soft-edged
      .map(([half,share]) => [half*extras.spread(), share]);
    if (beamBoost > 1) beamContext.globalCompositeOperation = "lighter";
    for (const turn of turns) for (const [half,share] of wedges) {
      let start = azimuth+turn-half;
      // Split a beam over any sector boundary rather than painting a wedge
      // into a dark sector merely because the beam's centre was visible.
      while (start < azimuth+turn+half) {
        const color = sectorColor(light,(start+360)%360);
        let end = start+1;
        while (end < azimuth+turn+half && sectorColor(light,(end+360)%360) === color) ++end;
        if (color) {
          const hex = lightColors[color];
          const gradient = beamContext.createRadialGradient(center.x,center.y,0,center.x,center.y,length);
          const alpha = Math.round(Math.min(1,strength*share)*255).toString(16).padStart(2,"0");
          gradient.addColorStop(0,hex+alpha);
          gradient.addColorStop(beamBoost > 1 ? .06 : .24,hex+alpha);
          gradient.addColorStop(1,hex+"00");
          beamContext.fillStyle=gradient;
          const wedge = new Path2D();
          wedge.moveTo(center.x,center.y);
          const stop = Math.min(end,azimuth+turn+half);
          for (let degrees = start; ; degrees = Math.min(stop,degrees+360/STEPS)) {
            const step = ((Math.round(degrees*STEPS/360)%STEPS)+STEPS)%STEPS;
            const radius = Math.min(length, reach[step]*pixelsPerMetre);
            const angle = (degrees-bearing-90)*Math.PI/180;
            wedge.lineTo(center.x+radius*Math.cos(angle), center.y+radius*Math.sin(angle));
            if (degrees >= stop) break;
          }
          wedge.closePath();
          beamContext.fill(wedge);
          extras.cut(wedge,center,length);
        }
        start=end;
      }
    }
    beamContext.globalCompositeOperation = "source-over";
  }
  const lamps = [];
  if (layersOn.lights) for (const [id,light] of chart.lights.entries()) {
    if (!light.colors.length || !bounds.contains(light.coordinates)) continue;
    const rhythm = rhythmById.get(id);
    if (!rhythm || sweepIds.has(id) || illuminated(rhythm,now))
      lamps.push({point:map.project(light.coordinates), color:lightColors[light.colors[0]]});
  }
  extras.finish(beamContext,now,night,lamps);
  beamFrame=requestAnimationFrame(drawBeams);
}

function startBeams() {
  if (!beamFrame && loaded && !document.hidden) beamFrame=requestAnimationFrame(drawBeams);
}

document.addEventListener("visibilitychange",startBeams);

function deadReckon(vessel, miles) {
  const heading = vessel.course*Math.PI/180;
  return [vessel.lon + Math.sin(heading)*miles/(60*Math.cos(vessel.lat*Math.PI/180)),
          vessel.lat + Math.cos(heading)*miles/60];
}

function projectCourse(vessel) {
  const heading = vessel.course*Math.PI/180;
  const length = vessel.speed/10;
  return [vessel.lon + Math.sin(heading)*length/(60*Math.cos(vessel.lat*Math.PI/180)),
          vessel.lat + Math.cos(heading)*length/60];
}

// How far (nautical miles) a ghost can run on its last course before meeting land. A ship whose
// dead reckoning would put it ashore has evidently turned or docked, so it stops being a ghost.
const landfalls = new Map();
function landfall(p) {
  const key = `${p.mmsi}/${p.lon}/${p.lat}/${p.course}/${p.speed}`;
  if (landfalls.has(key)) return landfalls.get(key);
  const reach = p.speed*ghostWindow/3600;
  const [ax,ay] = mercator([p.lon,p.lat]), [bx,by] = mercator(deadReckon(p,reach));
  const dx = bx-ax, dy = by-ay;
  let nearest = Infinity;
  for (const shore of shores) {
    if (shore.east < Math.min(ax,bx) || shore.west > Math.max(ax,bx) ||
        shore.south < Math.min(ay,by) || shore.north > Math.max(ay,by)) continue;
    for (const path of shore.paths) {
      for (let i=1; i<path.length; ++i) {
        const [cx,cy] = path[i-1], ex = path[i][0]-cx, ey = path[i][1]-cy;
        const cross = dx*ey-dy*ex;
        if (!cross) continue;
        const along = ((cx-ax)*ey-(cy-ay)*ex)/cross, edge = ((cx-ax)*dy-(cy-ay)*dx)/cross;
        if (along >= 0 && along <= 1 && edge >= 0 && edge <= 1) nearest = Math.min(nearest, along*reach);
      }
    }
  }
  landfalls.set(key, nearest);
  return nearest;
}

function updateShips(snapshot) {
  statusText = ({
    live:snapshot.refresh ? "AIS live" : "AIS snapshot", stale:"AIS snapshot · stale", waiting:"Waiting for ships",
    offline:"Ships temporarily unavailable", "not-configured":"Ships not configured",
  })[snapshot.status] || "Ships temporarily unavailable";
  const points = snapshot.points || [];
  const drifting = p => layersOn.ghosts && p.age > freshAge && p.age < ghostWindow && p.speed >= .5 && p.course != null
    && shores && p.speed*p.age/3600 < landfall(p);
  // Ghost positions move with time, so refresh the revision every 10 s while any exist.
  const revision = JSON.stringify(points.map(p => [p.mmsi,p.lon,p.lat,p.course,p.speed,
    p.age <= freshAge, p.age < 86400])) + (points.some(drifting) ? Math.floor(Date.now()/10000) : "");
  ships = new Map(points.map(p => [p.mmsi,p]));
  if (revision !== shipRevision) {
    shipRevision = revision;
    const symbols = [], vectors = [], drift = [];
    ghosts.clear();
    for (const p of points) {
      if (drifting(p)) {
        const at = deadReckon(p, p.speed*p.age/3600);
        const fade = .62*(1-p.age/ghostWindow)+.06;
        ghosts.set(p.mmsi, {...p, estimated:at});
        drift.push(point(at, {mmsi:p.mmsi, rotation:p.course, opacity:fade}, p.mmsi));
        drift.push({type:"Feature",properties:{opacity:fade*.55},geometry:{type:"LineString",coordinates:[[p.lon,p.lat],at]}});
        continue;
      }
      const fresh = p.age <= freshAge, moving = fresh && p.speed >= .5 && p.course != null;
      symbols.push(point([p.lon,p.lat], {mmsi:p.mmsi, rotation:moving?p.course:0, symbol:moving?"course-arrow":"stationary-diamond",
        opacity:fresh?.95:p.age<86400?.48:.24}, p.mmsi));
      if (moving) vectors.push({type:"Feature",properties:{},geometry:{
        type:"LineString",coordinates:[[p.lon,p.lat],projectCourse(p)],
      }});
    }
    map.getSource("ships").setData(collection(symbols));
    map.getSource("vectors").setData(collection(vectors));
    map.getSource("ghosts").setData(collection(drift));
  }
  const bounds = map.getBounds();
  const visible = points.filter(p => bounds.contains([p.lon,p.lat]));
  const fresh = visible.filter(p => p.age <= freshAge).length;
  status.textContent = points.length || snapshot.status === "live"
    ? `${statusText} · ${fresh} fresh · ${visible.length-fresh} last heard`
    : statusText;
}

function labelType(value) {
  if (!value) return "Type unreported";
  if (typeof value === "string") return value;
  const broad = {2:"Wing in ground",3:"Special craft",4:"High-speed craft",5:"Service vessel",
                 6:"Passenger",7:"Cargo",8:"Tanker",9:"Other"};
  return ({30:"Fishing",31:"Towing",32:"Towing",36:"Sailing",37:"Pleasure craft",50:"Pilot",
           51:"Search and rescue",52:"Tug",53:"Port tender",55:"Law enforcement"})[value]
    || broad[Math.floor(value/10)] || "Type unreported";
}

function placeLabels() {
  const zoom = map.getZoom();
  const width = map.getContainer().clientWidth;
  const height = map.getContainer().clientHeight;
  const occupied = [];
  for (const label of labels) {
    const {element, coordinates, min, max} = label;
    let opacity = layersOn.labels ? Math.min(1, (zoom-min)/.65, (max-zoom)/.65) : 0;   // labels are opt-in
    if (opacity <= 0) {
      element.style.opacity = "0";
      continue;
    }
    const margin = 7, frame = map.getContainer().getBoundingClientRect(), rect = element.getBoundingClientRect();
    const box = [rect.left-frame.left-margin, rect.top-frame.top-margin, rect.right-frame.left+margin, rect.bottom-frame.top+margin];
    if (box[0] < 5 || box[1] < 46 || box[2] > width-5 || box[3] > height-33 ||
        occupied.some(other=>box[0]<other[2] && box[2]>other[0] && box[1]<other[3] && box[3]>other[1])) {
      opacity=0;
    } else {
      occupied.push(box);
    }
    element.style.opacity = String(opacity*.86*labelScale);
  }
}

function showCard(title, rows, click) {
  const titleNode = document.createElement("strong");
  titleNode.textContent = title;
  const lines = rows.map(text => {
    const row = document.createElement("p");
    row.textContent = text;
    return row;
  });
  details.replaceChildren(titleNode,...lines);
  details.hidden = false;
  details.style.left = Math.max(8, Math.min(innerWidth-details.offsetWidth-8,click.x+15))+"px";
  details.style.top = Math.max(8, Math.min(document.querySelector("#dock").offsetTop-details.offsetHeight-8,click.y+14))+"px";
}

function highlight(feature) {
  const id = feature ? `${feature.layer.id}/${feature.id}` : null;
  if (!loaded || highlighted === id) return;
  highlighted = id;
  map.getSource("hover").setData(collection(feature ? [point(feature.geometry.coordinates, {}, id)] : []));
}

function clearHover() {
  details.hidden = true;
  highlight(null);
}

function inspect(event) {
  if (!loaded || map.isMoving()) {
    clearHover();
    return;
  }
  const {x,y} = event.point;
  const hoverable = ["vessels","ghosts","weather-buoys","marks","mark-labels","lights"].filter(id => map.getLayoutProperty(id,"visibility") !== "none");
  const radius = event.type === "mousemove" ? 5 : 14;
  const features = map.queryRenderedFeatures([[x-radius,y-radius],[x+radius,y+radius]], {layers:hoverable});
  const vessel = features.find(f=>f.layer.id==="vessels");
  const ghost = features.find(f=>f.layer.id==="ghosts");
  const buoy = features.find(f=>f.layer.id.startsWith("weather-buoy"));
  const lightFeature = features.find(f=>f.layer.id==="lights");
  let mark, markDistance = Infinity;
  for (const candidate of features) {
    if (!["marks","mark-labels"].includes(candidate.layer.id)) continue;
    const anchor = map.project(candidate.geometry.coordinates);
    const distance = Math.hypot(x - anchor.x, y - anchor.y);
    if (distance < markDistance) {
      mark = candidate;
      markDistance = distance;
    }
  }
  map.getCanvas().style.cursor = vessel || ghost || buoy || lightFeature || mark ? "pointer" : "";
  highlight(vessel || ghost || buoy || lightFeature || mark);
  if (!vessel && !ghost && !buoy && !lightFeature && mark) {
    const m = mark.properties;
    const names = {R:"red",G:"green",Y:"yellow",B:"black",W:"white",Bu:"blue"};
    const bands = [...(m.cs || m.c || "")].map(c => names[c]).filter(Boolean);
    const kind = m.k === "buoy" ? `${m.s ? m.s+" " : ""}buoy` : m.k;
    const purpose = (m.cat || "").replaceAll("_"," ");
    const character = m.lg ? `${m.lch || ""}(${m.lg})` : m.lch;
    const colours = (m.lcs || m.lc || "").split("/").map(c => names[c]).filter(Boolean).join("/");
    showCard(m.n || (bands[0] ? `${bands[0][0].toUpperCase()+bands[0].slice(1)} ${kind}` : `Chart ${kind}`), [
      [bands.join("/"), kind, purpose, m.ref && !m.n?.includes(m.ref) && m.ref].filter(Boolean).join(" · "),
      m.lit ? `Lit: ${[character, colours, m.lp && m.lp+" s"].filter(Boolean).join(" ") || "light details unrecorded"}` : "Lighting unrecorded",
      m.ll ? ["Canadian Coast Guard", `LL ${m.ll}`, m.date && `page ${m.date}`].filter(Boolean).join(" · ") : "OpenStreetMap",
    ],event.point);
    return;
  }
  if (!vessel && ghost) {
    const p = ghosts.get(ghost.properties.mmsi);
    if (!p) return;
    const minutes = Math.round(p.age/60);
    showCard(p.name || `MMSI ${p.mmsi}`, [
      `${labelType(p.type)} · estimated position`,
      `Last heard ${minutes < 60 ? minutes+"m" : Math.floor(minutes/60)+"h "+(minutes%60)+"m"} ago, out of AIS range`,
      `Dead-reckoned at ${p.speed.toFixed(1)} kn, ${Math.round(p.course)}° true`,
      `Destination: ${p.destination || "unreported"}`,
    ],event.point);
  } else if (!vessel && buoy) {
    const b = buoy.properties;
    const knots = v => v == null ? null : Math.round(v*1.944);
    const ago = Math.max(0, Math.round((Date.now()/1000-b.observed)/60));
    showCard(`${b.name} buoy`, [
      b.wspd == null ? "Wind unreported" : `Wind ${b.wdir == null ? "" : Math.round(b.wdir)+"° "}${knots(b.wspd)} kn${b.gst == null ? "" : `, gusts ${knots(b.gst)} kn`}`,
      [b.wvht == null ? "Waves unreported" : `Waves ${b.wvht.toFixed(1)} m${b.dpd == null ? "" : ` every ${Math.round(b.dpd)} s`}`,
       b.wtmp == null ? null : `water ${b.wtmp.toFixed(1)} °C`].filter(Boolean).join(" · "),
      `NOAA NDBC ${b.station} · observed ${ago < 60 ? ago+" min" : Math.floor(ago/60)+" h "+(ago%60)+" min"} ago`,
    ],event.point);
  } else if (vessel) {
    const p = ships.get(vessel.properties.mmsi);
    if (!p) return;
    const age = p.age < 60 ? `${p.age}s` : p.age < 3600 ? `${Math.floor(p.age/60)}m`
      : p.age < 86400 ? `${Math.floor(p.age/3600)}h` : `${Math.floor(p.age/86400)}d`;
    showCard(p.name || `MMSI ${p.mmsi}`, [
      `${labelType(p.type)} · heard ${age} ago`,
      `${p.speed == null ? "Speed unreported" : p.speed.toFixed(1)+" kn"} · ${p.course == null ? "Course unreported" : Math.round(p.course)+"° true"}`,
      `Destination: ${p.destination || "unreported"}`,
    ],event.point);
  } else if (lightFeature) {
    const light = chart.lights[lightFeature.properties.id];
    const names = {W:"white",G:"green",R:"red",Y:"yellow"};
    const signal = light.colors.map(color=>names[color]).join(", ");
    const character = light.character === "F" ? "Fixed light" : light.character || "Character unreported";
    showCard(light.name, light.note || [
      [character+(light.group ? `(${light.group})` : ""),light.period && `${light.period}s`,signal || "Colour unverified"].filter(Boolean).join(" · "),
      light.range ? `Nominal range ${light.range} nmi` : "Range unreported",
      ...(light.sectors?.length ? [light.sectors.map(([color,start,end])=>`${names[color]} ${start}°–${end}°`).join(" · ")+" from seaward"] : []),
    ],event.point);
  } else clearHover();
}
map.on("mousemove", inspect);
map.on("click", inspect);
const canvas = map.getCanvas();
canvas.addEventListener("pointerleave", event => {
  if (event.pointerType === "mouse") clearHover();
});
let touchStart;
canvas.addEventListener("touchstart", event => {
  touchStart = event.touches.length === 1 ? event.touches[0] : null;
}, {passive:true});
canvas.addEventListener("touchend", event => {
  const touch = event.changedTouches[0];
  const start = touchStart;
  touchStart = null;
  if (!start || event.touches.length || !touch || touch.identifier !== start.identifier ||
      Math.hypot(touch.clientX-start.clientX,touch.clientY-start.clientY) > 12) return;
  const frame = canvas.getBoundingClientRect();
  inspect({type:"touch",point:{x:touch.clientX-frame.left,y:touch.clientY-frame.top}});
}, {passive:true});
canvas.addEventListener("touchcancel", () => { touchStart = null; }, {passive:true});
map.on("movestart",clearHover);
map.on("moveend",placeLabels);
map.on("move",placeLabels);

const toggles = {
  ships:["vessels","course-vectors"], ghosts:["ghosts","ghost-trails"],
  buoys:["weather-buoys"], seamarks:["tss-zone","tss-lines","ferries","mark-glow","marks","mark-labels"],
  weather:[],                      // stub: future wind/precipitation overlay (e.g. Open-Meteo)
  lights:["light-halo","lights","light-sector-2","light-sector-3"],
};

// Sunrise/sunset for the chart (Halifax), from the standard sunrise equation; epoch seconds.
function sunTimes(t, lat = 44.65, lon = -63.6) {
  const rad = Math.PI/180, J2000 = 946728000;
  const n = Math.round((t-J2000)/86400 + lon/360);
  const noon = n - lon/360;
  const M = (357.5291 + .98560028*noon) % 360;
  const C = 1.9148*Math.sin(M*rad) + .02*Math.sin(2*M*rad) + .0003*Math.sin(3*M*rad);
  const L = (M + C + 282.9372) % 360;
  const transit = noon + .0053*Math.sin(M*rad) - .0069*Math.sin(2*L*rad);
  const dec = Math.asin(Math.sin(L*rad)*Math.sin(23.4397*rad));
  const cosH = (Math.sin(-.833*rad) - Math.sin(lat*rad)*Math.sin(dec))/(Math.cos(lat*rad)*Math.cos(dec));
  const half = Math.acos(Math.max(-1, Math.min(1, cosH)))/rad/360;
  return {rise: J2000 + (transit-half)*86400, set: J2000 + (transit+half)*86400};
}
const isDark = t => { const {rise,set} = sunTimes(t); return t < rise || t >= set; };

function wantNight(settings, now) {
  return settings.mode === "night" || (settings.mode === "auto" && isDark(now));
}

const modePaint = {
  // buoy lamps carry further after dark
  "mark-glow":{"circle-opacity":[["*",["coalesce",["feature-state","lit"],1],.6],["coalesce",["feature-state","lit"],1]],
    "circle-radius":[["interpolate",["linear"],["zoom"],9.2,2,11,4.5,14,10],["interpolate",["linear"],["zoom"],9.2,3,11,7.5,14,17]]},
  "deep":{"background-color":["#0b1414","#040808"]},
  "relief":{"raster-brightness-max":[1,.36],"raster-saturation":[0,-.55],"raster-contrast":[0,.25]},
  "water-depth-shading":{"raster-brightness-max":[1,.2]},
  "land-fill":{"fill-color":["#23352e","#0b1310"]},
  "fine-water":{"fill-color":[seaTint,"#050b0b"]},
  "coastline":{"line-color":["#687f70","#3a4e44"]},
  "fine-shoreline":{"line-color":["#526d62","#2c3e36"]},
  "waterways":{"line-color":["#41635d","#15211e"]},
  "bathymetry":{"line-color":["#567a71","#131e1b"]},
  "ferries":{"line-color":["#7f9a8e","#34433d"]},
  "tss-lines":{"line-color":["#8d6f96","#382d3d"]},
  "tss-zone":{"fill-opacity":[.09,.03]},
  "course-vectors":{"line-opacity":[.63,.3]},
  "vessels":{"icon-opacity":[["get","opacity"],["*",["get","opacity"],.5]]},
  "light-halo":{"circle-opacity":[["*",activeLight,["case",["get","fixed"],.28,.42]],["*",activeLight,["case",["get","fixed"],.36,.62]]]},
};

function setNight(value) {
  if (value === night) return;
  night = value;
  const index = night ? 1 : 0;
  for (const [layer, properties] of Object.entries(modePaint)) {
    if (!map.getLayer(layer)) continue;
    for (const [property, values] of Object.entries(properties)) map.setPaintProperty(layer, property, values[index]);
  }
  labelScale = night ? .38 : 1;
  beamBoost = night ? 1.9 : 1;
  placeLabels();
  // The button shows where a tap will take you: a moon by day, a sun by night.
  const toggle = document.querySelector("#mode");
  toggle.classList.toggle("is-night", night);
  toggle.title = night ? "Switch to chart mode" : "Switch to night mode";
  toggle.setAttribute("aria-label", toggle.title);

}

let settingsRevision = "", currentSettings = {mode:"auto", override:null, layers:layersOn};
function applySettings(settings) {
  if (settings) {
    const revision = JSON.stringify(settings);
    if (revision !== settingsRevision) {
      settingsRevision = revision;
      currentSettings = settings;
      layersOn = {...layersOn, ...(settings.layers || {})};
      for (const [toggle, layers] of Object.entries(toggles))
        for (const layer of layers)
          if (map.getLayer(layer)) map.setLayoutProperty(layer, "visibility", layersOn[toggle] ? "visible" : "none");
      weatherCard.hidden = !layersOn.weather || !weatherRevision || weatherRevision === "null";
      placeLabels();
      night = null;                                   // re-apply mode
      shipRevision = "";                              // ghosts toggle changes the ship split
    }
  }
  setNight(tourNight ?? wantNight(currentSettings, Date.now()/1000));
}

// Halifax weather card: bottom-left, stacked above the AIS counter at the same width (#dock).
const weatherCard = document.createElement("div");
weatherCard.className = "weather-card";
weatherCard.hidden = true;
document.querySelector("#dock").prepend(weatherCard);
let weatherRevision = "";
const conditions = {0:"Clear",1:"Mostly clear",2:"Partly cloudy",3:"Overcast",45:"Fog",48:"Freezing fog",
  51:"Light drizzle",53:"Drizzle",55:"Heavy drizzle",56:"Freezing drizzle",57:"Freezing drizzle",
  61:"Light rain",63:"Rain",65:"Heavy rain",66:"Freezing rain",67:"Freezing rain",71:"Light snow",73:"Snow",
  75:"Heavy snow",77:"Snow grains",80:"Showers",81:"Showers",82:"Heavy showers",85:"Snow showers",86:"Snow showers",
  95:"Thunderstorm",96:"Thunderstorm, hail",99:"Thunderstorm, hail"};
const compass = deg => ["N","NE","E","SE","S","SW","W","NW"][Math.round(((deg%360)+360)%360/45)%8];

function updateWeather(w) {
  extras.setWeather(w);
  const revision = JSON.stringify(w);
  if (revision === weatherRevision) return;
  weatherRevision = revision;
  if (!w) { weatherCard.hidden = true; return; }
  const deg = v => `${Math.round(v)}°`;
  const rows = [
    ["span","weather-place","Halifax"],
    ["strong","weather-temp",deg(w.temperature_2m)],
    ["span","weather-sky",conditions[w.weather_code] || "—"],
    ["p","weather-line",`Feels like ${deg(w.apparent_temperature)} · ${compass(w.wind_direction_10m)} ${Math.round(w.wind_speed_10m)} kn, gusts ${Math.round(w.wind_gusts_10m)}`],
  ];
  if (w.precipitation > 0) rows.push(["p","weather-line",`${w.precipitation} mm in the last 15 min`]);
  weatherCard.replaceChildren(...rows.map(([tag,cls,text]) => {
    const node = document.createElement(tag); node.className = cls; node.textContent = text; return node;
  }));
  weatherCard.hidden = !layersOn.weather;
}

function updateBuoys(stations) {
  const revision = JSON.stringify(stations.map(s => [s.id, s.observed]));
  if (revision === buoyRevision) return;
  buoyRevision = revision;
  const now = Date.now()/1000;
  map.getSource("buoys").setData(collection(stations.map(s => point(s.coordinates, {
    station:s.id, name:s.name, observed:s.observed, wdir:s.WDIR, wspd:s.WSPD, gst:s.GST, wvht:s.WVHT, dpd:s.DPD, wtmp:s.WTMP,
    toward: s.WDIR == null ? 0 : (s.WDIR+180)%360,     // arrow points downwind
    opacity: now - s.observed > 3*3600 ? .3 : .9,      // stale readings fade
  }, s.id))));
}

// The tour temporarily demonstrates the night rendering, then restores the selected mode.
let touring = false, tourNight = null, tourRevision = 0;
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
const viewControl = document.querySelector("#view");
const modeControl = document.querySelector("#mode");
const layerControls = document.querySelector("#layers fieldset");
const tourControl = document.querySelector("#tour");

const presets = {
  "halifax": () => map.easeTo({center:[-63.565,44.655], zoom:11.70, duration:450}),
  "halifax-coast": () => map.easeTo({center:[-63.616,44.569], zoom:10.85, duration:450}),
  "nova-scotia": () => applyOverview(450),
};
const storageKey = "night-atlas.preferences";
let saved = {};
try {
  saved = JSON.parse(localStorage.getItem(storageKey)) || {};
} catch {}
let preferences = {
  mode:["chart","night","auto"].includes(saved.mode) ? saved.mode : "auto",
  view:Object.hasOwn(presets,saved.view) ? saved.view : "nova-scotia",
  layers:{...layersOn},
};
for (const id of Object.keys(layersOn)) {
  if (typeof saved.layers?.[id] === "boolean") preferences.layers[id] = saved.layers[id];
}
function savePreferences() {
  try { localStorage.setItem(storageKey, JSON.stringify(preferences)); } catch {}
}

function endTour() {
  if (!touring) return;
  ++tourRevision;
  touring = false;
  tourNight = null;
  tourControl.textContent = "Tour";
  clearHover();
  applySettings(preferences);
}

// Ring and card for one named vessel, whatever else is moored on top of it.
function spotlight(p) {
  highlight({layer:{id:"vessels"}, id:p.mmsi, geometry:{coordinates:[p.lon,p.lat]}});
  const name = p.name.toLowerCase().replace(/\b\w/g, c => c.toUpperCase());
  showCard(name, ["Halifax Transit ferry", p.speed >= .5 ? `Last reported under way · ${p.speed.toFixed(1)} kn` : "At the terminal"],
    map.project([p.lon,p.lat]));
}

async function tour() {
  if (touring) { endTour(); map.stop(); return; }
  touring = true;
  const revision = ++tourRevision;
  tourControl.textContent = "Stop tour";
  viewControl.value = "custom";
  const reducedMotion = matchMedia("(prefers-reduced-motion: reduce)").matches;
  const peggys = chart.lights.find(light => /peggy/i.test(light.name))?.coordinates || [-63.9176,44.4921];
  // A Halifax Transit ferry from the latest snapshot, if one has been heard recently.
  const ferry = [...ships.values()].filter(p => p.age <= freshAge && /^(RITA JOE|CHRISTOPHER STANNIX)\b/i.test(p.name || ""))
    .sort((a,b) => (b.speed >= .5) - (a.speed >= .5) || a.age-b.age)[0];
  const stages = [
    {camera:overviewCamera(), duration:800, hold:2400},
    {camera:{center:peggys,zoom:12.6}, duration:5500, hold:2800, inspect:peggys},
    {camera:{center:[-63.48,44.52],zoom:10.6}, duration:4200, hold:2600, inspect:[-63.40,44.50]},
    {camera:{center:ferry ? [ferry.lon,ferry.lat] : [-63.565,44.635], zoom:ferry ? 13.4 : 12.4}, duration:3600, hold:4000, ferry},
    {camera:{center:[-63.52,44.60],zoom:11.6}, duration:4500, hold:600, night:true},
    {camera:overviewCamera(), duration:5200, hold:5000},
  ];
  for (const stage of stages) {
    if (revision !== tourRevision) return;
    if (!stage.camera) continue;
    if (stage.night) { tourNight = true; setNight(true); await wait(reducedMotion ? 0 : 2400); }   // stays dark
    if (revision !== tourRevision) return;
    clearHover();
    const duration = reducedMotion ? 0 : stage.duration;
    map.flyTo({...stage.camera, duration, essential:!reducedMotion});
    await wait(duration+100);
    if (revision !== tourRevision) return;
    if (stage.inspect) inspect({type:"mousemove",point:map.project(stage.inspect)});
    if (stage.ferry) spotlight(stage.ferry);
    await wait(stage.hold);
  }
  if (revision === tourRevision) {
    preferences.mode = "night";                        // the finale stays dark
    savePreferences();
    endTour();
    viewControl.value = "nova-scotia";
  }
}

function bindControls() {
  viewControl.disabled = modeControl.disabled = layerControls.disabled = tourControl.disabled = false;
  viewControl.value = preferences.view;
  const names = {ships:"Ships",ghosts:"Estimated positions",buoys:"Weather buoys",seamarks:"Seamarks",
    lights:"Lighthouses",weather:"Halifax weather",fog:"Fog",sky:"Cloud and moonlight",rain:"Rain and snow",spotlight:"Ship of the night",labels:"Place names"};
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
    const target = !night;
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
async function refreshBuoys() {
  try { updateBuoys((await read("/api/buoys")).stations); } catch { /* Keep last good readings. */ }
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

map.once("load", () => {
  function addVesselIcon(name, outline) {
    const icon = document.createElement("canvas");
    icon.width = icon.height = 42;
    const ctx = icon.getContext("2d");
    ctx.translate(21,21);
    ctx.beginPath();
    ctx.moveTo(...outline[0]);
    for (const vertex of outline.slice(1)) ctx.lineTo(...vertex);
    ctx.closePath();
    ctx.lineJoin = "round";
    ctx.strokeStyle = palette.surface;
    ctx.lineWidth = 3.5;
    ctx.stroke();
    ctx.fillStyle = palette.secondary;
    ctx.fill();
    map.addImage(name,ctx.getImageData(0,0,42,42),{pixelRatio:2});
  }
  addVesselIcon("course-arrow",[[0,-16],[12,13],[0,8],[-12,13]]);
  {
    const icon = document.createElement("canvas");
    icon.width = icon.height = 42;
    const ctx = icon.getContext("2d");
    ctx.translate(21,21);
    ctx.beginPath();
    for (const [i,[x,y]] of [[0,-16],[12,13],[0,8],[-12,13]].entries()) i ? ctx.lineTo(x,y) : ctx.moveTo(x,y);
    ctx.closePath();
    ctx.lineJoin = "round";
    ctx.setLineDash([4,3]);
    ctx.strokeStyle = palette.secondary;
    ctx.lineWidth = 2.6;
    ctx.stroke();
    map.addImage("ghost-arrow",ctx.getImageData(0,0,42,42),{pixelRatio:2});
  }
  const markColors = {R:"#c9544d",G:"#3f9f6c",Y:"#dcb84f",B:"#2a2e2d",W:"#e3e0d2","-":"#7b8a82"};
  const outlines = {
    conical:[[0,-26],[11,0],[-11,0]],
    can:[[-9,-20],[9,-20],[9,0],[-9,0]],
    spar:[[-4,-30],[4,-30],[4,0],[-4,0]],
    pillar:[[-4,-28],[4,-28],[10,0],[-10,0]],
    barrel:[[-11,-12],[11,-12],[11,0],[-11,0]],
    beacon:[[-2,-30],[2,-30],[2,0],[-2,0]],
  };
  function addMarkIcon(name, {k, s, cs, c, pat}) {
    if (map.hasImage(name)) return;
    const icon = document.createElement("canvas");
    icon.width = 40; icon.height = 44;
    const ctx = icon.getContext("2d");
    ctx.translate(20,38);
    const shape = k === "beacon" || s === "stake" || s === "tower" || s === "perch" ? "beacon"
      : (outlines[s] ? s : s === "spherical" ? "spherical" : s === "cylindrical" ? "can" : "pillar");
    ctx.beginPath();
    if (k === "light") ctx.arc(0,-3,5.5,0,Math.PI*2);
    else if (shape === "spherical") ctx.arc(0,-10,10,0,Math.PI*2);
    else outlines[shape].forEach(([x,y],i) => i ? ctx.lineTo(x,y) : ctx.moveTo(x,y));
    ctx.closePath();
    ctx.save();
    ctx.clip();
    const bands = [...(cs || c || "-")];
    const vertical = pat === "vertical";
    for (const [i,band] of bands.entries()) {      // painted top to bottom (or left to right)
      ctx.fillStyle = markColors[band] || markColors["-"];
      if (vertical) ctx.fillRect(-12+i*24/bands.length,-32,24/bands.length+.5,34);
      else ctx.fillRect(-12,-32+i*32/bands.length,24,32/bands.length+.5);
    }
    ctx.restore();
    ctx.lineJoin = "round";
    ctx.strokeStyle = "#0b1414";
    ctx.lineWidth = 2.2;
    ctx.stroke();
    if (k === "beacon") {                          // small top mark on the pole
      ctx.fillStyle = markColors[bands[0]] || markColors["-"];
      ctx.beginPath(); ctx.arc(0,-30,4.5,0,Math.PI*2); ctx.fill(); ctx.stroke();
    } else if (k === "buoy") {                      // waterline
      ctx.strokeStyle = "#8fb8b155"; ctx.lineWidth = 1.4;
      ctx.beginPath(); ctx.ellipse(0,1,13,2.6,0,0,Math.PI*2); ctx.stroke();
    }
    map.addImage(name, ctx.getImageData(0,0,40,44), {pixelRatio:2});
  }
  for (const feature of markFeatures) addMarkIcon(feature.properties.icon, feature.properties);
  {                                                // NOAA/ECCC weather buoy: yellow discus with mast
    const icon = document.createElement("canvas");
    icon.width = 44; icon.height = 48;
    const ctx = icon.getContext("2d");
    ctx.translate(22,42);
    ctx.lineJoin = "round"; ctx.strokeStyle = "#0b1414"; ctx.lineWidth = 2.2;
    ctx.fillStyle = "#dcb84f";
    ctx.beginPath(); ctx.moveTo(-3,-12); ctx.lineTo(3,-12); ctx.lineTo(2,-34); ctx.lineTo(-2,-34); ctx.closePath(); ctx.fill(); ctx.stroke();
    ctx.beginPath(); ctx.ellipse(0,-6,15,7,0,0,Math.PI*2); ctx.fill(); ctx.stroke();
    ctx.fillStyle = "#e4dfca"; ctx.beginPath(); ctx.arc(0,-35,3,0,Math.PI*2); ctx.fill(); ctx.stroke();
    ctx.strokeStyle = "#8fb8b155"; ctx.lineWidth = 1.4;
    ctx.beginPath(); ctx.ellipse(0,1,17,3,0,0,Math.PI*2); ctx.stroke();
    map.addImage("weather-buoy", ctx.getImageData(0,0,44,48), {pixelRatio:2});
  }

  addVesselIcon("stationary-diamond",[[0,-7],[7,0],[0,7],[-7,0]]);
  for (const [name, coordinates, min, max, importance, options = {}] of places) {
    const element=document.createElement("span");
    element.className=`place place-${importance}`;
    element.textContent=name;
    const anchor = document.createElement("div");
    anchor.append(element);
    new Marker({element:anchor, ...options}).setLngLat(coordinates).addTo(map);
    labels.push({element,coordinates,min,max});
  }
  loaded=true;
  bindControls();
  presets[preferences.view]();
  classifySweeps(sweeps);
  applySettings(preferences);
  const preview = new URLSearchParams(location.search).has("static");
  const credits = document.querySelector("#credits");
  new ResizeObserver(() => document.documentElement.style.setProperty("--credits-height", credits.offsetHeight+"px")).observe(credits);
  if (preview) status.textContent = "Ships not configured";
  else {
    refreshShips();
    document.addEventListener("visibilitychange", () => {
      if (!document.hidden && !shipRefreshTimer) refreshShips();
    });
    pollWhileVisible(refreshBuoys,1800000);
  }
  pollWhileVisible(refreshWeather,900000);
  pollWhileVisible(renderShips,10000);
  setInterval(() => applySettings(preferences),30000);
  map.on("moveend",renderShips);
  blink();
  startBeams();
  const gl=map.getCanvas().getContext("webgl2");
  console.info("Night Atlas MapLibre ready",gl?"WebGL2":"no WebGL2", gl?.getParameter(gl.MAX_TEXTURE_SIZE));
});
map.on("error", event => console.warn("Night Atlas map:", event.error?.message || "unknown error"));

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
