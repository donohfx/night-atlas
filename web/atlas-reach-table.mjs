import {MAX_REACH_STEP, METRES_PER_REACH_STEP, STEPS} from "./atlas-shore.mjs";

// Bump this when the canvas mask or sampling rules change.
export const reachFormat = 1;
export const lightKey = light => JSON.stringify([light.ccg_id ?? light.intl ?? light.source ?? "", light.name, light.coordinates]);

export async function reachRevision(text) {
  if (!globalThis.crypto?.subtle) return null;
  const bytes = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return Array.from(new Uint8Array(bytes), byte => byte.toString(16).padStart(2, "0")).join("");
}

export async function validatedReachTables(table, shoreline, combined, open) {
  if (!table || !shoreline || table.format !== reachFormat || table.shoreline !== shoreline) return {};
  const result = {};
  await Promise.all(Object.entries({combined, open}).map(async ([mode, lights]) => {
    const group = table[mode];
    if (!group?.entries || group.revision !== await reachRevision(JSON.stringify(lights))) return;
    result[mode] = group.entries;
  }));
  return result;
}

export function encodeReach(reach) {
  let bytes = "";
  for (const metres of reach) {
    const step = metres / METRES_PER_REACH_STEP;
    if (!Number.isInteger(step) || step < 0 || step > MAX_REACH_STEP) throw new Error(`Unrepresentable reach: ${metres}`);
    bytes += String.fromCharCode(step & 255, step >> 8);
  }
  return btoa(bytes);
}

export function decodeReach(entry) {
  if (typeof entry !== "string" || entry.length !== STEPS * 8 / 3) return null;
  let bytes;
  try { bytes = atob(entry); } catch { return null; }
  if (bytes.length !== STEPS * 2) return null;
  const reach = new Float32Array(STEPS);
  for (let i = 0; i < STEPS; ++i) {
    const step = bytes.charCodeAt(2*i) + (bytes.charCodeAt(2*i+1) << 8);
    if (step > MAX_REACH_STEP) return null;
    reach[i] = step * METRES_PER_REACH_STEP;
  }
  return reach;
}
