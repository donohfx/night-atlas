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
import {riverPainter} from "./paint-river-water.mjs";

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
  const cache = tiles.tileIndex?.tiles;
  assert(cache, "Review the tile cache adapter after updating MapLibre");
  archive(name, {minzoom, maxzoom, type:1, compression:2,
    metadata:{vector_layers:[{id:"_geojsonTileLayer", fields:name === "contours" ? {major:"Boolean"} : name === "provinces" ? {region:"String"} : {}}]}}, add => {
    const visit = (z,x,y) => {
      const tile = tiles.getTile(z,x,y);
      if (!tile?.numPoints) return;
      if (z >= minzoom && tile.features.length) {
        add(zxyToTileId(z,x,y), gzipSync(encode(new Wrapper(tile.features,{version:2,extent}), "__$json__:"), {level:1}));
      }
      if (z < maxzoom) for (let dy=0;dy<2;dy++) for (let dx=0;dx<2;dx++) visit(z+1,x*2+dx,y*2+dy);
      // This subtree is written: drop it, or the whole pyramid stays in memory.
      delete cache[((1<<z)*y+x)*32+z];
    };
    visit(0,0,0);
  });
}

function raster(name, input) {
  const size = 512, minzoom = 4, maxzoom = 8;
  const [left,top] = mercator([bounds[0],bounds[3]]);
  const [right,bottom] = mercator([bounds[2],bounds[1]]);
  const file = join(web,"region",input);
  const [width,height] = execFileSync(magick, ["identify","-limit","width","16KP","-limit","height","16KP","-format","%w %h",file], {encoding:"utf8"}).split(" ").map(Number);
  const rgb = execFileSync(magick, ["-limit","width","16KP","-limit","height","16KP",file,"-alpha","off","-depth","8","rgb:-"], {maxBuffer:width*height*3});
  const encoding = name === "relief" ? ["-quality","90","-define","webp:use-sharp-yuv=true"] :
    ["-define","webp:lossless=true"];
  const paint = name === "relief" &&
    riverPainter(new URL("river-water.json.gz", import.meta.url), mercator);
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
          if (paint) paint(pixels,size,z,x,y);
          add(zxyToTileId(z,x,y), execFileSync(magick, ["-size",size+"x"+size,"-depth","8","rgba:-",
            ...encoding,"-define","webp:method=2","webp:-"], {input:pixels,maxBuffer:pixels.length}));
        }
      }
    }
  });
}

function analysisArea(areas,x,y) {
  const id = zxyToTileId(analysisZoom,x,y);
  if (!areas.has(id)) areas.set(id,{});
  return areas.get(id);
}

function analysisArchive(name, areas) {
  archive(name,{minzoom:analysisZoom,maxzoom:analysisZoom,type:0,compression:2},add => {
    for (const [id,data] of areas) add(id,gzipSync(JSON.stringify(data)));
  });
}

function shore() {
  const areas = new Map();
  for (const {paths} of shorelinePaths(json("region/land.json"))) {
    for (const path of paths) for (let i=1; i<path.length; i++) {
      const [ax,ay] = path[i-1], [bx,by] = path[i];
      for (const [x,y] of analysisCells(ax,ay,bx,by)) {
        const cell = analysisArea(areas,x,y);
        (cell.segments ??= []).push([ax,ay,bx,by]);
      }
    }
  }
  analysisArchive("shore", areas);
}

async function beamReach() {
  // The hand-built lights keep their original NS beam silhouettes.
  const open = json("open-lights.json");
  const tables = await validatedReachTables(json("beam-reach.json"),
    await reachRevision(read("land.json")), chart.lights, open.lights);
  const regional = json("region/lights.json");
  const regionalTables = await validatedReachTables(json("region/beam-reach.json"),
    await reachRevision(read("region/land.json")), regional.lights, []);
  const areas = new Map();
  for (const [mode, {lights}, entries] of [["combined",chart,tables.combined], ["open",open,tables.open],
    ["combined",regional,regionalTables.combined]]) {
    for (const light of lights.filter(light => light.colors.length)) {
      const key = lightKey(light);
      const reach = entries?.[key];
      assert(decodeReach(reach), "Rebuild beam-reach.json for "+mode+" "+key);
      const [[x,y]] = analysisCells(...mercator(light.coordinates),...mercator(light.coordinates));
      (analysisArea(areas,x,y)[mode] ??= {})[key] = reach;
    }
  }
  analysisArchive("beam-reach", areas);
}

// One process per archive: each releases its memory before the next starts, so the
// whole build fits a small image builder. HEAP_MB caps each process.
const jobs = {
  land: async () => vector(await vectorTiler(),"land",7,14,.4),
  // Overscale the z14 contours. At this extent their encoding precision
  // already exceeds the source grid's precision, including Halifax.
  contours: async () => vector(await vectorTiler(),"contours",8,14,.375,18),
  provinces: async () => vector(await vectorTiler(),"provinces",3,13,.7),
  relief: () => raster("relief","relief.jpg"),
  "relief-detail": () => raster("relief-detail","relief-detail.webp"),
  shore,
  "beam-reach": beamReach,
};
const job = process.argv.find(arg => arg.startsWith("--job="))?.slice(6);

if (job) {
  try {
    assert(jobs[job], "Unknown job " + job);
    await jobs[job]();
    for (const name of readdirSync(stage)) renameSync(join(stage,name),join(output,name));
    console.log(`${job}: peak Node RSS ${process.resourceUsage().maxRSS} KiB`);
  } finally {
    rmSync(stage,{recursive:true,force:true});
  }
} else {
  rmSync(stage,{recursive:true,force:true});
  const heap = "--max-old-space-size=" + (process.env.HEAP_MB || 2048);
  const selected = process.argv.includes("--analysis-only") ? ["shore", "beam-reach"] : Object.keys(jobs);
  for (const name of selected) {
    execFileSync(process.execPath, [heap, fileURLToPath(import.meta.url), "--job="+name], {stdio:"inherit"});
  }
}
