// Paints inland river water into the relief tiles as they are built. The relief
// grid is too coarse to show the river, and drawing from polygons at each zoom
// keeps narrow reaches continuous. Input: tools/river-water.json.gz.
import {readFileSync} from "node:fs";
import {gunzipSync} from "node:zlib";

// The sea tone of build-atlas-live.py west of 69° W, and its coastline colour.
const SEA = [11,22,22], SHORE = [130,157,123];
const SUBROWS = 4;
// Wide views thicken the water and drop the bank lines, which would otherwise
// outweigh a river only a pixel or two across. Values are in tile pixels.
const WIDEN = {4:.8, 5:.7, 6:.45};
const SHORE_ALPHA = {7:.25, 8:.4};

function prepare(points, mercator) {
  const line = points.map(mercator);
  const xs = line.map(p => p[0]), ys = line.map(p => p[1]);
  return {line, box:[Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)]};
}

export function riverPainter(file, mercator) {
  const data = JSON.parse(gunzipSync(readFileSync(file)));
  const water = data.water.map(rings => rings.map(ring => prepare(ring, mercator)));
  const shores = data.shore.map(line => prepare(line, mercator));

  return function paint(pixels, size, z, x, y) {
    const scale = 2**z, pad = 2/(size*scale);
    const left = x/scale-pad, top = y/scale-pad, right = (x+1)/scale+pad, bottom = (y+1)/scale+pad;
    const visible = ({box}) => box[0] < right && box[2] > left && box[1] < bottom && box[3] > top;
    const local = ({line}) => line.map(([u,v]) => [(u*scale-x)*size, (v*scale-y)*size]);
    // The exterior ring bounds its holes.
    const polygons = water.filter(rings => visible(rings[0])).map(rings => rings.map(local));
    const banks = shores.filter(visible).map(local);
    if (!polygons.length && !banks.length) return;

    const cover = new Float32Array(size*size);
    for (const rings of polygons) fill(cover, size, rings);
    if (WIDEN[z]) {
      const edge = new Float32Array(size*size);
      for (const rings of polygons) for (const ring of rings) stroke(edge, size, ring, WIDEN[z]);
      for (let i=0; i<cover.length; i++) cover[i] = Math.max(cover[i], edge[i]);
    }
    blend(pixels, cover, SEA, 1);
    if (SHORE_ALPHA[z]) {
      const line = new Float32Array(size*size);
      for (const bank of banks) stroke(line, size, bank, .5);
      blend(pixels, line, SHORE, SHORE_ALPHA[z]);
    }
  };
}

// Even-odd scanline fill: exact across each row, supersampled down it.
function fill(cover, size, rings) {
  const rows = size*SUBROWS, crossings = new Map();
  for (const ring of rings) for (let i=1; i<ring.length; i++) {
    const [ax,ay] = ring[i-1], [bx,by] = ring[i];
    if (ay === by) continue;
    const first = Math.max(0, Math.ceil(Math.min(ay,by)*SUBROWS-.5));
    const end = Math.min(rows, Math.ceil(Math.max(ay,by)*SUBROWS-.5));
    for (let row=first; row<end; row++) {
      const at = ax+(bx-ax)*((row+.5)/SUBROWS-ay)/(by-ay);
      if (!crossings.has(row)) crossings.set(row, []);
      crossings.get(row).push(at);
    }
  }
  for (const [row, hits] of crossings) {
    hits.sort((a,b) => a-b);
    const offset = Math.floor(row/SUBROWS)*size;
    for (let i=1; i<hits.length; i+=2) {
      const start = Math.max(0,hits[i-1]), stop = Math.min(size,hits[i]);
      for (let column=Math.floor(start); column<stop; column++) {
        const part = Math.min(stop,column+1)-Math.max(start,column);
        cover[offset+column] = Math.min(1, cover[offset+column]+part/SUBROWS);
      }
    }
  }
}

// Antialiased line of the given half width. Overlapping segments do not add up.
function stroke(cover, size, line, half) {
  const reach = half+.5;
  for (let i=1; i<line.length; i++) {
    const [ax,ay] = line[i-1], [bx,by] = line[i];
    const dx = bx-ax, dy = by-ay, length = dx*dx+dy*dy;
    const lastColumn = Math.min(size-1, Math.floor(Math.max(ax,bx)+reach));
    const lastRow = Math.min(size-1, Math.floor(Math.max(ay,by)+reach));
    for (let row=Math.max(0,Math.floor(Math.min(ay,by)-reach)); row<=lastRow; row++) {
      for (let column=Math.max(0,Math.floor(Math.min(ax,bx)-reach)); column<=lastColumn; column++) {
        const px = column+.5-ax, py = row+.5-ay;
        const along = length ? Math.max(0,Math.min(1,(px*dx+py*dy)/length)) : 0;
        const amount = Math.min(1, reach-Math.hypot(px-along*dx, py-along*dy));
        if (amount > cover[row*size+column]) cover[row*size+column] = amount;
      }
    }
  }
}

function blend(pixels, cover, color, alpha) {
  for (let i=0; i<cover.length; i++) {
    const amount = cover[i]*alpha;
    if (!amount || !pixels[i*4+3]) continue;
    for (let c=0; c<3; c++) pixels[i*4+c] = Math.round(pixels[i*4+c]*(1-amount)+color[c]*amount);
  }
}
