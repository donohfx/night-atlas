export const lightMarkKey = mark => JSON.stringify([mark.properties.src, mark.properties.ll || "", mark.properties.n || "", mark.geometry.coordinates]);

const privateWarningFields = {src:"chs", k:"beacon", cat:"general warning mark", status:"private"};
export const isPrivateWarning = p => Object.entries(privateWarningFields).every(([key, value]) => p[key] === value);
export const privateWarningFilter = ["all", ...Object.entries(privateWarningFields)
  .map(([key, value]) => ["==", ["get", key], value])];

export function privateWarningTitle(p) {
  return p.n || (p.lit ? "Private warning light" : "Private warning mark");
}

export function nearestMark(hits) {
  const buoyHit = hits.some(({feature}) => feature.properties.k === "buoy");
  let best;
  for (const hit of hits) {
    if (buoyHit && isPrivateWarning(hit.feature.properties)) continue;
    if (!best || hit.distance < best.distance) best = hit;
  }
  return best?.feature;
}

export const isMark = f => f.geometry.type === "Point" && ["buoy","beacon"].includes(f.properties.k);
export const aidName = p => (p.ref || p.n || "").toUpperCase().replaceAll(/[^A-Z0-9]/g, "");
function markDistanceMeters([x,y], [ox,oy]) {
  return Math.hypot((x-ox)*Math.cos(y*Math.PI/180), y-oy)*111195;
}

// A 100 m latitude window bounds both matching rules. Longitude needs a
// wider window at higher latitudes because the distance uses the OSM latitude.
const cell = 0.01;
const maxLatitudeDelta = 100 / 111195;
function indexMarks(features) {
  const index = new Map();
  for (const mark of features) {
    const [x,y] = mark.geometry.coordinates;
    const rowKey = Math.floor(y/cell), column = Math.floor(x/cell);
    if (!index.has(rowKey)) index.set(rowKey, new Map());
    const row = index.get(rowKey);
    if (!row.has(column)) row.set(column, []);
    row.get(column).push({mark, name:aidName(mark.properties)});
  }
  return index;
}
function duplicateMark(f, index) {
  const [x,y] = f.geometry.coordinates;
  const name = aidName(f.properties);
  const dx = maxLatitudeDelta / Math.abs(Math.cos(y*Math.PI/180));
  const west = Math.floor((x-dx)/cell), east = Math.floor((x+dx)/cell);
  for (let j = Math.floor((y-maxLatitudeDelta)/cell); j <= Math.floor((y+maxLatitudeDelta)/cell); j++) {
    const row = index.get(j);
    if (!row) continue;
    // At the poles the longitude window can span every occupied column.
    for (const [column, candidates] of row) {
      if (column < west || column > east) continue;
      for (const {mark, name:candidate} of candidates) {
        if (f.properties.k !== mark.properties.k) continue;
        const distance = markDistanceMeters(f.geometry.coordinates, mark.geometry.coordinates);
        if ((name && name === candidate && distance <= 100)
          || (mark.properties.src === "chs" && distance <= 12 && (!name || !candidate))) return true;
      }
    }
  }
  return false;
}

export function markBuilder(marksData, aidsData, chsData, buoyMatches) {
  const chartMarks = chsData.features;
  const markByLightNumber = new Map();
  for (const mark of chartMarks) {
    const {k, ll, lit} = mark.properties;
    if (k !== "beacon" || !ll || lit !== 1) continue;
    if (!markByLightNumber.has(ll)) markByLightNumber.set(ll, []);
    markByLightNumber.get(ll).push(mark);
  }
  const fillIns = new Set(buoyMatches.fillIns);
  const ccgBuoys = new Map(aidsData.features.filter(f => f.properties.k === "buoy").map(f => [f.properties.ll,f]));
  const markKey = (coordinates, name) => JSON.stringify([coordinates, name || ""]);
  const ccgSignals = new Map(buoyMatches.overrides.map(o => [markKey(o.coordinates, o.name), ccgBuoys.get(o.ccg)]));
  const supplementalAids = () => aidsData.features.filter(f => {
    const p = f.properties;
    if (p.k === "buoy") return !chartMarks.length || fillIns.has(p.ll);
    return !markByLightNumber.get(p.ll)?.some(mark => {
      const q = mark.properties;
      return p.lch === q.lch && (p.lcs || p.lc) === (q.lcs || q.lc)
        && Number(p.lp || 0) === Number(q.lp || 0) && String(p.lg || 1) === String(q.lg || 1)
        && markDistanceMeters(f.geometry.coordinates, mark.geometry.coordinates) <= 20;
    });
  }).map(f => ({...f, properties:{...f.properties, src:"ccg"}}));
  const cache = new Map();
  return function marksFor(open) {
    if (cache.has(open)) return cache.get(open);
    const ccg = open ? [] : supplementalAids();
    const official = [...chartMarks, ...ccg.filter(isMark)];
    const index = indexMarks(official);
    const osm = marksData.features.filter(f => isMark(f) && !duplicateMark(f, index));
    const features = [...osm, ...ccg, ...chartMarks].map((f, id) => {
      const p = {...f.properties, src:f.properties.src || "osm"};
      const replacement = !open && p.src === "chs" && ccgSignals.get(markKey(f.geometry.coordinates, p.n));
      if (replacement && p.lit === 0) {
        const {lc, lcs, lch, lp, lg, seq} = replacement.properties;
        Object.assign(p, {lit:1, lc, lcs, lch, lp, lg, seq, signalSrc:"ccg"});
      }
      return {...f, id, properties:{...p, open, icon:`mk-${p.k}-${p.s || "pillar"}-${p.cs || p.c || "-"}-${p.pat || ""}`}};
    });
    cache.set(open, features);
    return features;
  };
}
