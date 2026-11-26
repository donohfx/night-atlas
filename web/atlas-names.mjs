import {PMTiles} from "./vendor/pmtiles.mjs";
import {mercator} from "./atlas-shore.mjs";
import {mergeNames, officialZoom, osmZoom, waterKinds} from "./place-names.mjs";

const osmLayers = ["place", "water_name", "waterway", "mountain_peak", "park"];
const placeKinds = {
  country:"country", state:"region", province:"region", city:"city", town:"town", village:"village",
  hamlet:"hamlet", isolated_dwelling:"hamlet", suburb:"neighbourhood", quarter:"neighbourhood",
  neighbourhood:"neighbourhood", island:"island", islet:"island", county:"region",
};
const blockerSizes = {lights:10, marks:13, "private-marks":14, "mark-labels":20,
  "private-mark-labels":24, vessels:15, ghosts:12, "weather-buoys":15};
// The gazetteer point for the Bay of Fundy is at its eastern shore.
// Use a chart anchor in open water for the long overview label.
const chartAnchors = new Map([["Bay of Fundy", [-65.82,45.15]]]);
// Two Sable Island landmarks from the former tour labels, absent at these
// positions in the official extract. Keep better overview anchors for
// Newfoundland and Labrador and a local anchor for the Halifax Narrows.
const local = [
  [-56.125,48.54167,"Island of Newfoundland","island",6],
  [-59.7,53.1,"Labrador","region",6],
  [-60.023,43.932,"West End","point",12],
  [-59.791,43.960,"East End","point",12],
  [-63.590,44.668,"The Narrows","channel",13],
].map(([lon,lat,name,kind,zoom]) => ({lon,lat,name,kind,zoom,source:"official"}));

function osmKind(layer, properties, name) {
  const type = properties.class;
  if (layer === "place") return placeKinds[type];
  if (layer === "waterway") return ({river:"river", stream:"river", canal:"channel"})[type];
  if (layer === "mountain_peak") return "peak";
  if (layer === "park") return "park";
  if (["ocean","sea","gulf"].includes(type) || /\bgulf\b|^golfe /i.test(name)) return "sea";
  if (/\bstrait\b|^détroit /i.test(name)) return "strait";
  if (/\bharbou?r\b|^port /i.test(name)) return "harbour";
  if (/\bbay\b|^baie /i.test(name)) return "bay";
  if (/\bcove\b|^anse /i.test(name)) return "cove";
  if (/\b(?:river|creek|brook|fleuve|rivière|ruisseau)\b/i.test(name)) return "river";
  return "lake";
}

function anchor(geometry, center) {
  if (geometry.type === "Point") return geometry.coordinates;
  const lines = geometry.type === "LineString" ? [geometry.coordinates]
    : geometry.type === "MultiLineString" ? geometry.coordinates : [];
  // Choose a point on the visible reaches of named waterways.
  let nearest;
  let distance = Infinity;
  for (const line of lines) {
    for (let i = 1; i < line.length; i++) {
      const [x,y] = line[i-1], [endX,endY] = line[i];
      const dx = endX-x, dy = endY-y;
      const t = Math.max(0, Math.min(1, ((center.lng-x)*dx + (center.lat-y)*dy)/(dx*dx + dy*dy || 1)));
      const lon = x+t*dx, lat = y+t*dy;
      const d = (center.lng-lon)**2+(center.lat-lat)**2;
      if (d < distance) {
        nearest = [lon,lat];
        distance = d;
      }
    }
  }
  return nearest;
}

function readOsm(map) {
  const result = [];
  const center = map.getCenter();
  for (const layer of osmLayers) {
    for (const feature of map.querySourceFeatures("osm", {sourceLayer:layer, filter:["has","name"]})) {
      const p = feature.properties;
      const name = p.name;
      const kind = osmKind(layer, p, name);
      if (!kind) continue;
      const anchorPoint = anchor(feature.geometry, center);
      if (!anchorPoint) continue;
      const [lon,lat] = anchorPoint;
      const rank = Number(p.rank ?? 5);
      let zoom = osmZoom(kind, rank);
      if (layer === "waterway") zoom = kind === "river" && p.class === "river" ? 10 : 13;
      if (p.class === "county") zoom = 12;
      if (p.class === "islet") zoom = 13;
      result.push({lon,lat,name,kind,zoom,rank,source:"osm",
        aliases:[p["name:fr"],p["name:en"],p.name_en,p.name_int,p["name:latin"]].filter(Boolean)});
    }
  }
  return result;
}

const order = (a,b) => a.zoom-b.zoom || (b.scale || 0)-(a.scale || 0) ||
  (a.rank ?? 0)-(b.rank ?? 0) || a.name.localeCompare(b.name) || a.lon-b.lon || a.lat-b.lat;

function grid(size) {
  const occupied = new Map();
  function cells([left,top,right,bottom]) {
    const keys = [];
    for (let x = Math.floor(left/size); x <= Math.floor(right/size); x++) {
      for (let y = Math.floor(top/size); y <= Math.floor(bottom/size); y++) keys.push(x + "/" + y);
    }
    return keys;
  }
  return {
    hits(box) {
      return cells(box).some(key => occupied.get(key)?.some(other =>
        box[0] < other[2] && box[2] > other[0] && box[1] < other[3] && box[3] > other[1]));
    },
    add(box) {
      for (const key of cells(box)) {
        if (!occupied.has(key)) occupied.set(key, []);
        occupied.get(key).push(box);
      }
    },
  };
}

export function placeNames(map, archiveUrl, enabled) {
  const archive = new PMTiles(archiveUrl);
  const decoder = new TextDecoder();
  const tiles = new Map();
  const canvas = document.createElement("canvas");
  canvas.className = "chart-names";
  canvas.setAttribute("aria-hidden", "true");
  map.getContainer().append(canvas);
  const context = canvas.getContext("2d");
  let night = false, ready = false, frame, needsRefresh = true, candidates = [];
  let diagnostics = {};
  let refreshOnIdle = false;

  function refresh() {
    const bounds = map.getBounds();
    const zoom = Math.max(5, Math.min(12, Math.floor(map.getZoom()+.001)));
    const n = 2**zoom;
    const [left,top] = mercator([bounds.getWest(),bounds.getNorth()]);
    const [right,bottom] = mercator([bounds.getEast(),bounds.getSouth()]);
    const official = [];
    for (let x = Math.floor(left*n); x <= Math.floor(right*n); x++) {
      for (let y = Math.floor(top*n); y <= Math.floor(bottom*n); y++) {
        const key = zoom + "/" + x + "/" + y;
        let tile = tiles.get(key);
        if (!tile) {
          tile = {};
          tiles.set(key, tile);
          archive.getZxy(zoom,x,y).then(result => {
            tile.points = result ? JSON.parse(decoder.decode(result.data)).map(([lon,lat,name,kind,scale,...aliases]) =>
              ({lon,lat,name,kind,scale,aliases,zoom:officialZoom(kind,scale,name),source:"official"})) : [];
            schedule(true);
          }).catch(error => {
            console.warn("Harbour Watch gazetteer:", error.message);
            setTimeout(() => { tiles.delete(key); schedule(true); }, 10000);
          });
        }
        tile.used = performance.now();
        if (tile.points) official.push(...tile.points);
      }
    }
    if (tiles.size > 180) {
      const evict = [...tiles].filter(([,tile]) => tile.points)
        .sort(([,a],[,b]) => a.used-b.used).slice(0,tiles.size-144);
      for (const [key] of evict) tiles.delete(key);
    }
    const nearby = point => bounds.contains([point.lon,point.lat]);
    const osm = readOsm(map).filter(nearby);
    const primary = [...official, ...local].filter(nearby).sort(order);
    const merged = mergeNames(primary, osm.sort(order));
    candidates = merged.points.sort(order);
    diagnostics = {official:primary.length, osm:osm.length, suppressed:merged.counts};
  }

  function draw() {
    frame = undefined;
    const {clientWidth:width,clientHeight:height} = map.getContainer();
    const pixelRatio = devicePixelRatio || 1;
    const w = Math.round(width*pixelRatio), h = Math.round(height*pixelRatio);
    if (canvas.width !== w || canvas.height !== h) {
      canvas.width = w;
      canvas.height = h;
    }
    context.setTransform(pixelRatio,0,0,pixelRatio,0,0);
    context.clearRect(0,0,width,height);
    if (!enabled || !ready) return;
    if (needsRefresh) {
      needsRefresh = false;
      refresh();
    }

    const zoom = map.getZoom();
    const occupied = grid(64), blockers = grid(64);
    const layers = Object.keys(blockerSizes).filter(id => map.getLayer(id));
    for (const feature of map.queryRenderedFeatures({layers})) {
      if (feature.geometry.type !== "Point") continue;
      const {x,y} = map.project(feature.geometry.coordinates);
      const radius = blockerSizes[feature.layer.id];
      blockers.add([x-radius,y-radius,x+radius,y+radius]);
    }
    for (const id of ["controls","dock","credits","details","rotate","simulated-weather"]) {
      const element = document.getElementById(id);
      if (!element || element.hidden) continue;
      const {left,top,right,bottom} = element.getBoundingClientRect();
      if (right > left && bottom > top) blockers.add([left-6,top-5,right+6,bottom+5]);
    }
    const limit = Math.max(8, Math.floor(width*height / (zoom < 8 ? 50000 : zoom < 12 ? 30000 : 20500)));
    let drawn = 0;
    const visible = [];
    const repeated = new Map();
    context.textAlign = "center";
    context.textBaseline = "middle";
    context.lineJoin = "round";
    context.lineWidth = 2.75;

    for (const place of candidates) {
      if (drawn >= limit || place.zoom > zoom + .001) break;
      if (place.kind === "country" && zoom > 7 || place.kind === "region" && place.zoom <= 6 && zoom > 10) continue;
      const anchor = zoom < 10 && place.source === "official" && chartAnchors.get(place.name);
      const {x,y} = map.project(anchor || [place.lon,place.lat]);
      if (x < 5 || y < 5 || x > width-5 || y > height-5) continue;
      const water = waterKinds.has(place.kind);
      const major = place.zoom <= 8;
      const fontSize = major ? 14 : 12;
      const name = place.name;
      const last = repeated.get(name);
      // Line segments can recur across tile boundaries and along a long river.
      if (last?.some(point => Math.hypot(point.x-x,point.y-y) < (water ? 420 : 185))) continue;
      context.font = `${water ? "italic " : ""}${major ? 600 : 400} ${fontSize}px system-ui, sans-serif`;
      const half = context.measureText(name).width / 2;
      const pad = zoom < 8 ? 18 : 8;
      const offsets = major
        ? [[0,0],[0,-17],[0,17],[-24,-22],[24,-22],[-36,0],[36,0],[0,-39],[0,39],[-48,-30],[-48,25],[48,-30],[48,30]]
        : water ? [[0,0],[0,-17],[0,17],[0,-28],[0,28]] : [[0,0],[0,-16],[0,16]];
      for (const [dx,dy] of offsets) {
        const px = x+dx, py = y+dy;
        const box = [px-half-3,py-fontSize/2-3,px+half+3,py+fontSize/2+3];
        if (box[0] < 0 || box[1] < 0 || box[2] > width || box[3] > height ||
            blockers.hits(box) || occupied.hits(box)) continue;
        occupied.add([box[0]-pad,box[1]-pad,box[2]+pad,box[3]+pad]);
        context.strokeStyle = night ? "#0b1414" : "#142523";
        context.fillStyle = water ? (night ? "#829f9a" : "#a3c1b9") : (night ? "#a9aa98" : "#dddac2");
        context.strokeText(name,px,py);
        context.fillText(name,px,py);
        if (!last) repeated.set(name, []);
        repeated.get(name).push({x,y});
        visible.push({name,kind:place.kind,source:place.source});
        drawn++;
        break;
      }
    }
    diagnostics.visible = visible;
  }

  function schedule(refreshCandidates = false) {
    needsRefresh ||= refreshCandidates;
    if (frame === undefined) frame = requestAnimationFrame(draw);
  }

  map.on("load", () => {
    // The shoreline uses this same vector source. Keep its tiles in the source
    // cache at overview zooms, where the shoreline layers are out of range.
    map.addLayer({id:"osm-place-tiles", type:"circle", source:"osm", "source-layer":"place",
      paint:{"circle-opacity":0}, layout:{visibility:enabled ? "visible" : "none"}});
    ready = true;
    schedule(true);
  });
  map.on("move", () => schedule());
  map.on("moveend", () => {
    refreshOnIdle = true;
    schedule(true);
  });
  map.on("idle", () => {
    if (!refreshOnIdle) return;
    refreshOnIdle = false;
    schedule(true);
  });
  map.on("resize", () => schedule(true));
  map.on("sourcedata", event => {
    if (event.sourceId === "osm") schedule(true);
    else if (event.sourceDataType === "content" && ["lights","ships","ghosts","marks","buoys"].includes(event.sourceId)) schedule();
  });
  return {
    get diagnostics() { return diagnostics; },
    show(on) {
      if (enabled === on) { schedule(); return; }
      enabled = on;
      if (ready) map.setLayoutProperty("osm-place-tiles", "visibility", on ? "visible" : "none");
      schedule(true);
    },
    night(on) {
      night = on;
      schedule();
    },
  };
}
