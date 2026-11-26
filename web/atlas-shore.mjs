const REACH = 30000, OWN_LAND = 250;     // metres; a light shines over its own rock or headland
const MASK = 2048;
export const STEPS = 720;
export const MAX_REACH_STEP = MASK / 2;
export const METRES_PER_REACH_STEP = REACH / MAX_REACH_STEP;
export const mercator = ([lon,lat]) => [(lon+180)/360, (1-Math.asinh(Math.tan(lat*Math.PI/180))/Math.PI)/2];
export const metresPerUnit = lat => 40075016.7*Math.cos(lat*Math.PI/180);

export function shorelinePaths(land) {
  return land.features.flatMap(({geometry:g}) =>
    (g.type === "Polygon" ? [g.coordinates] : g.coordinates).map(rings => {
      const paths = rings.map(ring => ring.map(mercator));
      let west = 1, north = 1, east = 0, south = 0;
      for (const [x,y] of paths[0]) {
        west = Math.min(west,x); east = Math.max(east,x);
        north = Math.min(north,y); south = Math.max(south,y);
      }
      return {paths,west,north,east,south};
    }));
}

// Rasterise nearby land and find the first obstruction on each half-degree bearing.
export function beamReach(light, shores) {
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
