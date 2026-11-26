import {createHash} from "node:crypto";
import {openSync, closeSync, writeSync} from "node:fs";
import {gzipSync} from "node:zlib";

function directory(entries) {
  const bytes = [];
  function put(value) {
    while (value >= 128) {
      bytes.push(value % 128 + 128);
      value = Math.floor(value / 128);
    }
    bytes.push(value);
  }
  put(entries.length);
  let previousId = 0;
  for (const {id} of entries) {
    put(id - previousId);
    previousId = id;
  }
  for (const {run} of entries) put(run);
  for (const {length} of entries) put(length);
  let end = -1;
  for (const {offset, length} of entries) {
    put(offset === end ? 0 : offset + 1);
    end = offset + length;
  }
  return gzipSync(Buffer.from(bytes));
}

// PMTiles v3. Payloads are spooled to disk, so building a pyramid does not
// require holding its compressed tile data in memory.
export function writeArchive(path, {bounds, minzoom, maxzoom, type, compression, metadata}, generate) {
  const fd = openSync(path, "w+");
  const entries = [], contents = new Map();
  let dataLength = 0;
  const dataOffset = 16384;
  try {
    generate((id, body) => {
      const hash = createHash("sha256").update(body).digest("hex");
      let entry = contents.get(hash);
      if (!entry) {
        entry = {offset:dataLength, length:body.length};
        writeSync(fd, body, 0, body.length, dataOffset + dataLength);
        dataLength += body.length;
        contents.set(hash, entry);
      }
      entries.push({id, run:1, ...entry});
    });
    entries.sort((a,b) => a.id-b.id);
    const runs = [];
    for (const entry of entries) {
      const last = runs.at(-1);
      if (last && last.id + last.run === entry.id && last.offset === entry.offset) last.run++;
      else runs.push(entry);
    }
    let root = directory(runs), leafLength = 0;
    const meta = gzipSync(Buffer.from(JSON.stringify(metadata)));
    const metaOffset = dataOffset + dataLength, leafOffset = metaOffset + meta.length;
    if (root.length > dataOffset - 127) {
      let leafSize = 4096;
      while (true) {
        const leaves = [];
        leafLength = 0;
        for (let i=0; i<runs.length; i+=leafSize) {
          const leaf = directory(runs.slice(i, i+leafSize));
          leaves.push({id:runs[i].id, run:0, offset:leafLength, length:leaf.length});
          writeSync(fd, leaf, 0, leaf.length, leafOffset + leafLength);
          leafLength += leaf.length;
        }
        root = directory(leaves);
        if (root.length <= dataOffset - 127) break;
        leafSize *= 2;
      }
    }
    writeSync(fd, meta, 0, meta.length, metaOffset);
    const header = Buffer.alloc(127);
    header.write("PMTiles");
    header[7] = 3;
    [127, root.length, metaOffset, meta.length, leafOffset, leafLength, dataOffset, dataLength,
      entries.length, runs.length, contents.size].forEach((value,i) => header.writeBigUInt64LE(BigInt(value),8+i*8));
    header.set([0, 2, compression, type, minzoom, maxzoom],96);
    bounds.forEach((value,i) => header.writeInt32LE(Math.round(value*1e7),102+i*4));
    header[118] = minzoom;
    header.writeInt32LE(Math.round((bounds[0]+bounds[2])*5e6),119);
    header.writeInt32LE(Math.round((bounds[1]+bounds[3])*5e6),123);
    writeSync(fd, header, 0, header.length, 0);
    writeSync(fd, root, 0, root.length, 127);
    console.log(path, entries.length, "tiles,", leafOffset + leafLength, "bytes");
  } finally {
    closeSync(fd);
  }
}
