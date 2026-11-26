import {addProtocol} from "./vendor/maplibre-gl.mjs";
import {PMTiles, Protocol} from "./vendor/pmtiles.mjs";

import {analysisCells, analysisZoom} from "./atlas-area.mjs";

export function tiledAtlas(tileBase) {
  const base = new URL(tileBase, location.href);
  if (!base.pathname.endsWith("/")) base.pathname += "/";
  const protocol = new Protocol();
  // The archive reader manages a consistent archive revision. Let HTTP cache
  // the ranges without scheduling separate MapLibre reloads for each tile.
  addProtocol("pmtiles",async (request,controller) => {
    const {data} = await protocol.tile(request,controller);
    return {data};
  });
  const url = name => new URL(name+".pmtiles",base).href;
  const source = (name,type) => ({type,url:"pmtiles://"+url(name), ...(type === "raster" ? {tileSize:512} : {})});
  const archives = {shore:new PMTiles(url("shore")), reach:new PMTiles(url("beam-reach"))};
  const cells = new Map();
  const decoder = new TextDecoder();

  function cell(kind,x,y,onReady) {
    const key = kind+"/"+x+"/"+y;
    const entry = cells.get(key);
    if (entry) {
      if (!entry.data && onReady) entry.callbacks.add(onReady);
      return entry.data;
    }
    const pending = {callbacks:new Set(onReady ? [onReady] : [])};
    cells.set(key,pending);
    archives[kind].getZxy(analysisZoom,x,y).then(tile => {
      pending.data = tile ? JSON.parse(decoder.decode(tile.data)) : {};
      // Keep a bounded cache when panning across a large coverage area.
      if (cells.size > 160) {
        for (const [key,value] of cells) {
          if (cells.size <= 128) break;
          if (value.data && value !== pending) cells.delete(key);
        }
      }
      for (const callback of pending.callbacks) callback();
      pending.callbacks.clear();
    }).catch(error => {
      console.warn("Night Atlas analysis tile:", error.message);
      setTimeout(() => cells.delete(key),5000);
    });
  }

  return {
    provinceSource:source("provinces","vector"),
    sources:{land:source("land","vector"),contours:source("contours","vector"),
      relief:source("relief","raster"),close:source("relief-detail","raster")},
    reach(x,y,mode,key) {
      const [[col,row]] = analysisCells(x,y,x,y);
      return cell("reach",col,row)?.[mode]?.[key];
    },
    segments(ax,ay,bx,by,onReady) {
      const areas = analysisCells(ax,ay,bx,by).map(([x,y]) => cell("shore",x,y,onReady));
      if (areas.every(Boolean)) return areas.flatMap(area => area.segments || []);
    },
  };
}
