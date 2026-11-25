const stations = {
  "44258": ["Halifax Harbour", -63.40, 44.50],
  "44150": ["La Have Bank", -64.02, 42.50],
  "44137": ["East Scotia Slope", -62.03, 42.26],
  "44139": ["Banquereau Bank", -57.10, 44.24],
  "44488": ["East of Chedabucto Bay", -60.95, 45.44],
  "44011": ["Georges Bank", -66.55, 41.09],
};
const fields = ["WDIR", "WSPD", "GST", "WVHT", "DPD", "WTMP"];
export const config = {path: "/api/buoys"};

export function parseBuoy(text) {
  const [header, , ...rows] = text.trim().split(/\r?\n/);
  const columns = header.replace(/^#/, "").trim().split(/\s+/);
  if (columns.slice(0,5).join(" ") !== "YY MM DD hh mm") return null;
  for (const line of rows) {
    const values = line.trim().split(/\s+/);
    const [year, month, day, hour, minute] = values.slice(0, 5).map(Number);
    const observed = Date.UTC(year, month - 1, day, hour, minute) / 1000;
    if (!Number.isFinite(observed) || year < 2000) continue;
    const reading = Object.fromEntries(fields.map(key => {
      const value = Number(values[columns.indexOf(key)]);
      return [key, Number.isFinite(value) ? value : null];
    }));
    if (Object.values(reading).some(value => value !== null)) return {observed, ...reading};
  }
  return null;
}

export default async function buoys(request) {
  if (request.method !== "GET") return new Response(null, {status: 405, headers: {Allow: "GET"}});
  const readings = await Promise.allSettled(Object.entries(stations).map(async ([id, [name, lon, lat]]) => {
    const response = await fetch(`https://www.ndbc.noaa.gov/data/realtime2/${id}.txt`, {
      signal: AbortSignal.timeout(8500),
      headers: {"User-Agent": "night-atlas/1.0"},
    });
    if (!response.ok) return null;
    const reading = parseBuoy(await response.text());
    return reading && {id, name, coordinates: [lon, lat], ...reading};
  }));
  const available = readings.flatMap(result => result.status === "fulfilled" && result.value ? [result.value] : []);
  return Response.json({stations: available}, {
    status: available.length ? 200 : 503,
    headers: {
      "Cache-Control": "public, max-age=60",
      "Netlify-CDN-Cache-Control": available.length
        ? "public, durable, s-maxage=900, stale-while-revalidate=900, stale-if-error=3600"
        : "public, s-maxage=60",
    },
  });
}
