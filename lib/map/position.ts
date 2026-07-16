// Pure Client-Helfer für beide Karten: Position eines Fahrzeugs aus seinen
// Halt-Zeiten interpolieren — entlang des echten Fahrwegs (Segment-Polyline),
// wenn vorhanden, sonst Luftlinie. Plus Tier-Farben.

export type LiveCall = [lon: number, lat: number, arr: number, dep: number, key?: string];
export type Segment = [number, number][];

// Kumulierte Längen je Segment cachen (Bogenlängen-Parametrisierung).
const lengthCache = new WeakMap<Segment, number[]>();

function cumulative(seg: Segment): number[] {
  let cum = lengthCache.get(seg);
  if (cum) return cum;
  cum = [0];
  for (let i = 1; i < seg.length; i++) {
    const dx = seg[i][0] - seg[i - 1][0];
    // Längen in "Grad-Metrik" reichen — nur die VERHÄLTNISSE zählen; cos(lat)
    // korrigiert die Ost-West-Verzerrung, damit Kurven gleichmässig ablaufen.
    const dy = (seg[i][1] - seg[i - 1][1]) / Math.cos((seg[i][1] * Math.PI) / 180);
    cum.push(cum[i - 1] + Math.hypot(dx, dy));
  }
  lengthCache.set(seg, cum);
  return cum;
}

/** Punkt bei Anteil f (0..1) der Bogenlänge einer Polyline. */
export function pathPosition(seg: Segment, f: number): { lon: number; lat: number } {
  const cum = cumulative(seg);
  const target = Math.max(0, Math.min(1, f)) * cum[cum.length - 1];
  // Binärsuche nach dem Teilstück
  let lo = 0;
  let hi = cum.length - 1;
  while (lo < hi - 1) {
    const mid = (lo + hi) >> 1;
    if (cum[mid] <= target) lo = mid;
    else hi = mid;
  }
  const span = cum[hi] - cum[lo];
  const t = span > 0 ? (target - cum[lo]) / span : 0;
  return {
    lon: seg[lo][0] + (seg[hi][0] - seg[lo][0]) * t,
    lat: seg[lo][1] + (seg[hi][1] - seg[lo][1]) * t,
  };
}

/**
 * Position aus den Halt-Zeiten. `segmentFor(pairKey)` darf fehlen (Luftlinie)
 * oder undefined liefern („Segment (noch) unbekannt" — Aufrufer kann es laden).
 */
export function trainPosition(
  c: LiveCall[],
  nowSec: number,
  segmentFor?: (pairKey: string) => Segment | null | undefined,
  onMissing?: (pairKey: string) => void,
): { lon: number; lat: number; moving: boolean; next: number } | null {
  // `next` = Index des Calls, auf den das Fahrzeug gerade zufährt bzw. an dem
  // es steht — erlaubt dem Popup, veraltete "Nächster Halt"-Labels zu erkennen.
  if (!c || c.length === 0) return null;
  const first = c[0];
  const last = c[c.length - 1];
  if (nowSec <= first[2]) return { lon: first[0], lat: first[1], moving: false, next: 0 };
  if (nowSec >= last[3]) {
    // Nach dem letzten bekannten Halt noch kurz stehen lassen, dann ausblenden.
    return nowSec > last[3] + 120
      ? null
      : { lon: last[0], lat: last[1], moving: false, next: c.length - 1 };
  }
  for (let i = 0; i < c.length; i++) {
    const [lon, lat, arr, dep] = c[i];
    if (nowSec >= arr && nowSec <= dep) return { lon, lat, moving: false, next: i }; // am Halt
    const next = c[i + 1];
    if (next && nowSec > dep && nowSec < next[2]) {
      const f = (nowSec - dep) / Math.max(1, next[2] - dep);
      const keyA = c[i][4];
      const keyB = next[4];
      if (segmentFor && keyA && keyB) {
        const pairKey = `${keyA}-${keyB}`;
        const seg = segmentFor(pairKey);
        if (seg) return { ...pathPosition(seg, f), moving: true, next: i + 1 };
        if (seg === undefined) onMissing?.(pairKey);
      }
      return {
        lon: lon + (next[0] - lon) * f,
        lat: lat + (next[1] - lat) * f,
        moving: true,
        next: i + 1,
      };
    }
  }
  return { lon: last[0], lat: last[1], moving: false, next: c.length - 1 };
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
