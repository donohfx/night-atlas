import {open} from "node:fs/promises";
import {pipeline} from "node:stream/promises";

function byteRange(value, size) {
  const match = /^bytes=(\d*)-(\d*)$/.exec(value);
  if (!match || !(match[1] || match[2]) || !size) return null;
  const start = match[1] ? Number(match[1]) : Math.max(0, size-Number(match[2]));
  const end = match[1] && match[2] ? Math.min(size-1,Number(match[2])) : size-1;
  return start <= end && end < size ? {start,end} : null;
}

export async function sendArchive(req, res, path, security) {
  const file = await open(path,"r");
  try {
    const {size, mtimeMs} = await file.stat();
    const etag = `"${size.toString(16)}-${Math.trunc(mtimeMs).toString(16)}"`;
    const headers = {...security, "Content-Type":"application/vnd.pmtiles",
      "Accept-Ranges":"bytes", "Cache-Control":"public, max-age=300", ETag:etag};
    if (req.headers["if-none-match"] === etag) {
      res.writeHead(304, headers);
      return res.end();
    }
    let range;
    if (req.headers.range && (!req.headers["if-range"] || req.headers["if-range"] === etag)) {
      range = byteRange(req.headers.range, size);
      if (!range) {
        res.writeHead(416, {...headers, "Content-Range":`bytes */${size}`, "Content-Length":0});
        return res.end();
      }
      headers["Content-Range"] = `bytes ${range.start}-${range.end}/${size}`;
    }
    headers["Content-Length"] = range ? range.end-range.start+1 : size;
    res.writeHead(range ? 206 : 200, headers);
    if (req.method === "HEAD") return res.end();
    await pipeline(file.createReadStream({...range, autoClose:false}), res).catch(error => {
      if (error.code !== "ERR_STREAM_PREMATURE_CLOSE") throw error;
    });
  } finally {
    await file.close();
  }
}
