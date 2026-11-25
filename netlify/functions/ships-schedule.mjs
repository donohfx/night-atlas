// Keeps the ship snapshot reasonably recent when nobody is visiting. A scheduled function only
// gets 30 s, too short to collect, so it asks the ships endpoint, which collects in the background
// if the snapshot is stale and holds the lock against overlapping collectors.
export default async () => {
  const site = process.env.URL;
  if (!site) return console.warn("Scheduled ship refresh: no site URL");
  const response = await fetch(new URL("/api/ships", site), { signal: AbortSignal.timeout(20_000) });
  const { status } = await response.json();
  console.log(`Scheduled ship refresh: HTTP ${response.status}, ${status}`);
};

export const config = { schedule: "*/15 * * * *" };
