export const waterKinds = new Set(["sea", "bay", "harbour", "cove", "strait", "channel",
  "passage", "lake", "river", "bank", "shoal", "ledge", "undersea", "falls", "rapids", "spring"]);
const seabed = new Set(["bank", "shoal", "ledge", "undersea"]);
const settlements = new Set(["city", "town", "village", "hamlet", "neighbourhood", "municipality"]);
const thresholds = {
  country:5, city:6, town:8, village:10, hamlet:11, neighbourhood:12, municipality:10,
  region:6, sea:5, strait:7, bay:8, harbour:9, lake:8, river:8, island:7,
  channel:10, passage:10, cove:11, cape:10, point:11, head:11, bank:9, shoal:11, ledge:11, undersea:10,
};

export function officialZoom(kind, scale, name) {
  if (["Bay of Fundy", "Cape Breton Island", "Northumberland Strait"].includes(name)) return 6;
  if (kind === "region") return scale >= 30e6 ? 5 : scale >= 7.5e6 ? 10 : 13;
  if (kind === "municipality") return scale >= 7.5e6 ? 10 : 13;
  const floor = thresholds[kind] ?? 11;
  if (kind === "sea" && scale >= 5e6) return 5;
  if (kind === "park" || kind === "district") return scale >= 5e6 ? 12 : 14;
  const tier = scale >= 15e6 ? 5 : scale >= 5e6 ? 7 : scale >= 1e6 ? 9 : scale >= 250000 ? 11 : 13;
  return Math.max(floor, tier - (settlements.has(kind) ? 1 : 0));
}

export function osmZoom(kind, rank) {
  if (kind === "city") return rank <= 5 ? 6 : rank <= 10 ? 7 : 8;
  if (kind === "park") return rank <= 3 ? 13 : 14;
  if (kind === "region") return rank <= 4 ? 5 : 7;
  if (kind === "lake" || kind === "bay" || kind === "island") {
    return rank <= 1 ? 7 : rank <= 3 ? 9 : rank <= 7 ? 11 : 12;
  }
  return thresholds[kind] ?? 12;
}

const normalize = name => name.normalize("NFKD").replace(/\p{M}/gu, "").toLowerCase()
  .replace(/[’']/g, "").replace(/[^\p{L}\p{N}]+/gu, " ").trim()
  .replace(/\b(?:saint|ste|sainte)\b/g, "st").replace(/\b(?:harbour|harbor)\b/g, "harbour");

const waters = [
  ["bay", /^(?:baie|anse) (?:des? |du |d )?| (?:bay|cove)$/g],
  ["river", /^(?:riviere|fleuve) (?:des? |du |d )?| river$/g],
  ["lake", /^lac (?:des? |du |d )?|^lake | lake$/g],
  ["strait", /^detroit (?:des? |du |d )?|^strait of | strait$/g],
  ["sea", /^golfe (?:des? |du |d )?|^gulf of | gulf$/g],
  ["harbour", /^port (?:des? |du |d )?| harbour$/g],
  ["channel", /^chenal (?:des? |du |d )?| channel$/g],
  ["island", /^iles? (?:des? |du |d )?| islands?$/g],
];
const family = kind => settlements.has(kind) || kind === "district" ? "settlement"
  : seabed.has(kind) ? "seabed" : kind === "cove" ? "bay" : kind === "passage" ? "channel" : kind;
const distance = (a,b) => {
  const latitude = (a.lat + b.lat) * Math.PI / 360;
  return 111.2 * Math.hypot((a.lon-b.lon)*Math.cos(latitude), a.lat-b.lat);
};

function keys(feature) {
  const result = new Set();
  const group = family(feature.kind);
  const generic = waters.find(([kind]) => kind === group)?.[1];
  const short = feature.name.replace(/\s*\([^()]+\)$/, "");
  for (const name of [feature.name, short, ...(feature.aliases || [])]) {
    const key = normalize(name);
    if (!key) continue;
    result.add(key);
    const root = generic && key.replace(generic, "").trim();
    if (root && root !== key && root !== "the" && root !== "s") result.add(root);
  }
  return result;
}

export function mergeNames(official, osm) {
  const byName = new Map();
  const points = [];
  const counts = {official:0, crossSource:0, osm:0};
  for (const candidate of [...official, ...osm]) {
    const aliases = keys(candidate);
    const neighbors = new Set([...aliases].flatMap(key => [...(byName.get(key) || [])]));
    const group = family(candidate.kind);
    const radius = group === "sea" ? 260 : group === "region" ? 140
      : group === "settlement" ? (candidate.zoom <= 8 ? 14 : 2)
      : candidate.zoom <= 9 ? 20 : candidate.zoom <= 11 ? 2.5 : .65;
    let match;
    let nearest = Infinity;
    for (const existing of neighbors) {
      const sameIsland = [existing.kind, candidate.kind].includes("island") &&
        [family(existing.kind), group].includes("settlement") && normalize(existing.name) === normalize(candidate.name);
      const compatible = sameIsland || family(existing.kind) === group ||
        // OSM water_name sometimes does not distinguish open bays from straits.
        (existing.source !== candidate.source && [existing.kind, candidate.kind].includes("bay") &&
          [existing.kind, candidate.kind].some(kind => ["strait", "channel", "harbour", "passage"].includes(kind)));
      if (!compatible) continue;
      const delta = distance(existing, candidate);
      const relatedSeabed = group === "seabed" && existing.kind !== candidate.kind;
      const limit = sameIsland || relatedSeabed ? 3 : group === "settlement" && existing.zoom <= 8 ? Math.max(radius, 14)
        : existing.source !== candidate.source && waterKinds.has(candidate.kind)
          ? Math.max(radius, group === "river" ? 10 : 5) : radius;
      if (delta <= limit && delta < nearest) {
        match = existing;
        nearest = delta;
      }
    }
    if (match) {
      if (match.source !== candidate.source) {
        counts.crossSource++;
        // A mapped city node can represent the urban centre better than the
        // CGNDB municipal point. Retain the official name and earlier zoom.
        if (group === "settlement" && family(match.kind) === group && !match.mappedCentre &&
            (candidate.zoom < match.zoom || ["city", "town"].includes(candidate.kind))) {
          Object.assign(match, {lon:candidate.lon, lat:candidate.lat, kind:candidate.kind, mappedCentre:true});
        }
        match.zoom = Math.min(candidate.zoom, match.zoom);
      } else {
        counts[candidate.source]++;
      }
    } else {
      match = {...candidate};
      points.push(match);
    }
    for (const key of aliases) {
      if (!byName.has(key)) byName.set(key, new Set());
      byName.get(key).add(match);
    }
  }
  return {points, counts};
}
