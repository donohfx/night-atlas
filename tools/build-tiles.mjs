import assert from "node:assert/strict";
import {execFileSync} from "node:child_process";
import {mkdtempSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync} from "node:fs";
import {join} from "node:path";
import {fileURLToPath} from "node:url";
import {gzipSync} from "node:zlib";
import {lightKey, reachRevision, validatedReachTables, decodeReach} from "../web/atlas-reach-table.mjs";
import {mercator, shorelinePaths} from "../web/atlas-shore.mjs";
import {zxyToTileId} from "../web/vendor/pmtiles.mjs";
import {analysisCells, analysisZoom} from "../web/atlas-area.mjs";
import {writeArchive} from "./write-pmtiles.mjs";

const web = fileURLToPath(new URL("../web/", import.meta.url));
const output = join(web, "tiles");
mkdirSync(output, {recursive:true});
const stage = mkdtempSync(join(output, ".build-"));
const read = name => readFileSync(join(web, name), "utf8");
const json = name => JSON.parse(read(name));
const chart = json("chart-data.json");
const {dataBounds: bounds} = json("region/config.json");
const magick = process.env.MAGICK || "magick";

function archive(name, options, generate) {
  const path = join(stage, name + ".pmtiles");
  writeArchive(path, {bounds, metadata:{name}, ...options}, generate);
}

// The pinned MapLibre worker already includes the GeoJSON tiler and MVT
// encoder. Use those same implementations and source options at build time.
async function vectorTiler() {
  const worker = read("vendor/maplibre-gl-worker.mjs");
  const index = /function (\w+)\(e,t,n\)\{return new \w+\(e,\w+\(t\.geojsonVtOptions/.exec(worker)?.[1];
  const encoder = /rawData:(\w+)\(a,`__\$json__:`\)\.buffer/.exec(worker)?.[1];
  const wrapper = /let a=new (\w+)\(i\.features,\{version:2,extent:M\}\);return\{vectorTile:a/.exec(worker)?.[1];
  assert(index && encoder && wrapper, "Review the tiler adapter after updating MapLibre");
  globalThis.self = globalThis;
  return import("data:text/javascript;base64," + Buffer.from(worker +
    `\nexport { ${index} as index, ${encoder} as encode, ${wrapper} as Wrapper };`).toString("base64"));
}

function vector({index, encode, Wrapper}, name, minzoom, maxzoom, tolerance, indexMaxzoom = maxzoom) {
  const extent = 8192;
  const tiles = index(json("region/" + name + ".json"), {geojsonVtOptions:{extent, maxZoom:indexMaxzoom,
    buffer:2048, tolerance:tolerance*16}}, false);
  archive(name, {minzoom, maxzoom, type:1, compression:2,
    metadata:{vector_layers:[{id:"_geojsonTileLayer", fields:name === "contours" ? {major:"Boolean"} : name === "provinces" ? {region:"String"} : {}}]}}, add => {
    const visit = (z,x,y) => {
      const tile = tiles.getTile(z,x,y);
      if (!tile?.numPoints) return;
      if (z >= minzoom && tile.features.length) {
        add(zxyToTileId(z,x,y), gzipSync(encode(new Wrapper(tile.features,{version:2,extent}), "__$json__:"), {level:1}));
      }
      if (z < maxzoom) for (let dy=0;dy<2;dy++) for (let dx=0;dx<2;dx++) visit(z+1,x*2+dx,y*2+dy);
    };
    visit(0,0,0);
  });
}

function raster(name, input) {
  const size = 512, minzoom = 5, maxzoom = 8;
  const [left,top] = mercator([bounds[0],bounds[3]]);
  const [right,bottom] = mercator([bounds[2],bounds[1]]);
  const file = join(web,"region",input);
  const [width,height] = execFileSync(magick, ["identify","-format","%w %h",file], {encoding:"utf8"}).split(" ").map(Number);
  const rgb = execFileSync(magick, [file,"-alpha","off","-depth","8","rgb:-"], {maxBuffer:width*height*3});
  archive(name, {minzoom,maxzoom,type:4,compression:1}, add => {
    for (let z=minzoom; z<=maxzoom; z++) {
      const scale = 2**z;
      for (let y=Math.floor(top*scale); y<Math.ceil(bottom*scale); y++) {
        for (let x=Math.floor(left*scale); x<Math.ceil(right*scale); x++) {
          const pixels = Buffer.alloc(size*size*4);
          for (let row=0;row<size;row++) {
            const v = ((y+(row+.5)/size)/scale-top)/(bottom-top);
            if (v < 0 || v >= 1) continue;
            const sy = Math.max(0,Math.min(height-1,v*height-.5));
            const j = Math.floor(sy), k = Math.min(j+1,height-1), fy = sy-j;
            for (let col=0;col<size;col++) {
              const u = ((x+(col+.5)/size)/scale-left)/(right-left);
              if (u < 0 || u >= 1) continue;
              const sx = Math.max(0,Math.min(width-1,u*width-.5));
              const i = Math.floor(sx), n = Math.min(i+1,width-1), fx = sx-i;
              const p = (row*size+col)*4;
              for (let c=0;c<3;c++) {
                const a = rgb[(j*width+i)*3+c]*(1-fx)+rgb[(j*width+n)*3+c]*fx;
                const b = rgb[(k*width+i)*3+c]*(1-fx)+rgb[(k*width+n)*3+c]*fx;
                pixels[p+c] = Math.round(a*(1-fy)+b*fy);
              }
              pixels[p+3] = 255;
            }
          }
          add(zxyToTileId(z,x,y), execFileSync(magick, ["-size",size+"x"+size,"-depth","8","rgba:-",
            "-define","webp:lossless=true","-define","webp:method=2","webp:-"], {input:pixels,maxBuffer:pixels.length}));
        }
      }
    }
  });
}

async function analysis() {
  // The hand-built lights keep their original NS beam silhouettes. The
  // regional shoreline is used for landfall detection across the web chart.
  const legacyLand = read("land.json");
  const regionalLand = read("region/land.json");
  const land = JSON.parse(regionalLand);
  const open = json("open-lights.json");
  const tables = await validatedReachTables(json("beam-reach.json"), await reachRevision(legacyLand), chart.lights, open.lights);
  const regional = json("region/lights.json");
  const regionalTables = await validatedReachTables(json("region/beam-reach.json"),
    await reachRevision(regionalLand), regional.lights, []);
  const shore = new Map(), reaches = new Map();
  function area(areas,x,y) {
    const id = zxyToTileId(analysisZoom,x,y);
    if (!areas.has(id)) areas.set(id,{});
    return areas.get(id);
  }
  for (const {paths} of shorelinePaths(land)) {
    for (const path of paths) for (let i=1; i<path.length; i++) {
      const [ax,ay] = path[i-1], [bx,by] = path[i];
      for (const [x,y] of analysisCells(ax,ay,bx,by)) {
        const cell = area(shore,x,y);
        (cell.segments ??= []).push([ax,ay,bx,by]);
      }
    }
  }
  for (const [mode, {lights}, entries] of [["combined",chart,tables.combined], ["open",open,tables.open],
    ["combined",regional,regionalTables.combined]]) {
    for (const light of lights.filter(light => light.colors.length)) {
      const key = lightKey(light);
      const reach = entries?.[key];
      assert(decodeReach(reach), "Rebuild beam-reach.json for "+mode+" "+key);
      const [[x,y]] = analysisCells(...mercator(light.coordinates),...mercator(light.coordinates));
      (area(reaches,x,y)[mode] ??= {})[key] = reach;
    }
  }
  for (const [name,areas] of [["shore",shore],["beam-reach",reaches]]) {
    archive(name,{minzoom:analysisZoom,maxzoom:analysisZoom,type:0,compression:2},add => {
      for (const [id,data] of areas) add(id,gzipSync(JSON.stringify(data)));
    });
  }
}

try {
  if (process.argv.includes("--analysis-only")) await analysis();
  else {
    const tiler = await vectorTiler();
    vector(tiler,"land",7,15,.4);
    vector(tiler,"contours",8,16,.375,18);
    vector(tiler,"provinces",3,13,.7);
    raster("relief","relief.jpg");
    raster("relief-detail","relief-detail.webp");
    await analysis();
  }
  for (const name of readdirSync(stage)) renameSync(join(stage,name),join(output,name));
} finally {
  rmSync(stage,{recursive:true,force:true});
}
