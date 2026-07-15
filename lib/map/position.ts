// Pure Client-Helfer für beide Karten: Position eines Fahrzeugs aus seinen
// Halt-Zeiten interpolieren (Luftlinie zwischen Halten, v1) + Tier-Farben.

export type LiveCall = [lon: number, lat: number, arr: number, dep: number];

export function trainPosition(
  c: LiveCall[],
  nowSec: number,
): { lon: number; lat: number; moving: boolean } | null {
  if (!c || c.length === 0) return null;
  const first = c[0];
  const last = c[c.length - 1];
  if (nowSec <= first[2]) return { lon: first[0], lat: first[1], moving: false };
  if (nowSec >= last[3]) {
    // Nach dem letzten bekannten Halt noch kurz stehen lassen, dann ausblenden.
    return nowSec > last[3] + 120 ? null : { lon: last[0], lat: last[1], moving: false };
  }
  for (let i = 0; i < c.length; i++) {
    const [lon, lat, arr, dep] = c[i];
    if (nowSec >= arr && nowSec <= dep) return { lon, lat, moving: false }; // am Halt
    const next = c[i + 1];
    if (next && nowSec > dep && nowSec < next[2]) {
      const f = (nowSec - dep) / Math.max(1, next[2] - dep);
      return {
        lon: lon + (next[0] - lon) * f,
        lat: lat + (next[1] - lat) * f,
        moving: true,
      };
    }
  }
  return { lon: last[0], lat: last[1], moving: false };
}

export const TIER_COLORS: Record<number, string> = {
  1: '#e00514', // Fernverkehr — Zügli-Rot
  2: '#2d5f9e', // Regionalverkehr — Blau
  3: '#8c4a9e', // Tram/Metro — Violett
  4: '#686868', // Bus/übrige — Grau
};

export const TIER_LABELS: Record<number, string> = {
  1: 'Fernverkehr',
  2: 'Regionalverkehr',
  3: 'Tram/Metro',
  4: 'Bus',
};

/** Ab welcher Zoomstufe ein Tier automatisch dazukommt. */
export const TIER_MIN_ZOOM: Record<number, number> = { 1: 0, 2: 9, 3: 10.5, 4: 11.5 };
