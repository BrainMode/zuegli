// Fahrweg-Segmente (echte Strecken-/Strassengeometrie zwischen zwei
// NACHBAR-Halten) — lazy aus OJP gelernt statt GTFS-Shapes zu parsen
// (das offizielle Schweizer GTFS und die freien geOps-Feeds enthalten KEINE
// shapes.txt; OJP 2.0 liefert die Geometrie aber per IncludeLegProjection —
// verifiziert für Zug UND Bus).
//
// Ablauf: Der Karten-Client fragt /api/shape?pairs=keyA-keyB,… an. Bekannte
// Segmente kommen aus dem Cache (Redis 60 d + In-Memory-LRU); für unbekannte
// wird (budget-limitiert) EIN OJP-TripRequest mit LegProjection gestellt und
// die vereinfachte Polyline dauerhaft gecacht. Das Netz „füllt sich" so über
// die ersten Betriebstage von selbst. Unpaarbare Segmente (Umstieg nötig,
// Ausland) werden als null-Marker gecacht, damit nichts erneut anfragt.

import { Redis } from '@upstash/redis';
import { cachePut, cacheGet } from '../cache';
import { ojpRequest, arr, txt, OjpError } from './client';

const hasUpstash = Boolean(
  process.env.UPSTASH_REDIS_REST_URL && process.env.UPSTASH_REDIS_REST_TOKEN,
);
const redis = hasUpstash ? Redis.fromEnv() : null;

// Globaler Minuten-Deckel fürs Segment-Lernen: Die OJP-API erlaubt 50 req/min
// GETEILT mit dem Chat — ohne Deckel hungert das Lernen im 429 und drosselt
// nebenbei die Chat-Tools (beobachtet: Plateau nach Burst-Start).
const SHAPE_PER_MIN = Number(process.env.SHAPE_LEARN_PER_MIN ?? 20);

async function underMinuteCap(n: number): Promise<boolean> {
  if (!redis) return true;
  try {
    const key = `zuegli:shape:rate:${Math.floor(Date.now() / 60_000)}`;
    const used = await redis.incrby(key, n);
    if (used === n) await redis.expire(key, 120);
    return used <= SHAPE_PER_MIN;
  } catch {
    return true;
  }
}

const stamp = () => new Date().toISOString();

export type Segment = [number, number][]; // [lon, lat], vereinfacht

// ── Geometrie-Helfer ────────────────────────────────────────────────────────

/** Douglas-Peucker-Vereinfachung (Toleranz in Grad; 0.0001 ≈ 10 m). */
export function simplify(points: Segment, tolerance = 0.0001): Segment {
  if (points.length <= 2) return points;
  const sqTol = tolerance * tolerance;
  const keep = new Uint8Array(points.length);
  keep[0] = keep[points.length - 1] = 1;
  const stack: Array<[number, number]> = [[0, points.length - 1]];
  while (stack.length) {
    const [first, last] = stack.pop()!;
    let maxDist = 0;
    let index = -1;
    const [x1, y1] = points[first];
    const [x2, y2] = points[last];
    const dx = x2 - x1;
    const dy = y2 - y1;
    const len2 = dx * dx + dy * dy;
    for (let i = first + 1; i < last; i++) {
      const [px, py] = points[i];
      let t = len2 > 0 ? ((px - x1) * dx + (py - y1) * dy) / len2 : 0;
      t = Math.max(0, Math.min(1, t));
      const ex = x1 + t * dx - px;
      const ey = y1 + t * dy - py;
      const d = ex * ex + ey * ey;
      if (d > maxDist) {
        maxDist = d;
        index = i;
      }
    }
    if (maxDist > sqTol && index > 0) {
      keep[index] = 1;
      stack.push([first, index], [index, last]);
    }
  }
  const out: Segment = [];
  for (let i = 0; i < points.length; i++) if (keep[i]) out.push(points[i]);
  return out;
}

// ── OJP-Fetch eines Segments ────────────────────────────────────────────────

type Pt = Record<string, any>;

export type ModeClass = 'r' | 't' | 'b'; // rail | tram/metro | bus/übrige

/**
 * Modusfilter je Klasse (Syntax gegen den Schweizer OJP verifiziert):
 * WICHTIG: ohne <Exclude>false</Exclude> wirkt der Filter als AUSSCHLUSS.
 * Ohne Filter verdrängen häufige Busse die Bahn aus den Ergebnissen
 * (Nutzer-Fund S6 Luzern–Littau: alle Kandidaten waren Busse → Miss-Marker
 * fürs Bahn-Segment, Zug fuhr Luftlinie).
 */
function modeFilter(cls: ModeClass): string {
  if (cls === 'r') {
    return '<ModeAndModeOfOperationFilter><Exclude>false</Exclude><PtMode>rail</PtMode></ModeAndModeOfOperationFilter>';
  }
  if (cls === 't') {
    return '<ModeAndModeOfOperationFilter><Exclude>false</Exclude><PtMode>tram</PtMode><PtMode>metro</PtMode></ModeAndModeOfOperationFilter>';
  }
  return '<ModeAndModeOfOperationFilter><Exclude>true</Exclude><PtMode>rail</PtMode><PtMode>tram</PtMode><PtMode>metro</PtMode></ModeAndModeOfOperationFilter>';
}

function projectionTripRequest(cls: ModeClass, fromRef: string, toRef: string): string {
  const now = stamp();
  return `<OJPTripRequest>
        <siri:RequestTimestamp>${now}</siri:RequestTimestamp>
        <Origin>
          <PlaceRef><siri:StopPointRef>${fromRef}</siri:StopPointRef><Name><Text>-</Text></Name></PlaceRef>
          <DepArrTime>${now}</DepArrTime>
        </Origin>
        <Destination>
          <PlaceRef><siri:StopPointRef>${toRef}</siri:StopPointRef><Name><Text>-</Text></Name></PlaceRef>
        </Destination>
        <Params>
          ${modeFilter(cls)}
          <NumberOfResults>3</NumberOfResults>
          <UseRealtimeData>none</UseRealtimeData>
          <IncludeLegProjection>true</IncludeLegProjection>
        </Params>
      </OJPTripRequest>`;
}

/** Passt der PtMode eines Legs zur Verkehrsmittel-Klasse des Fahrzeugs? */
function modeMatches(cls: ModeClass, ptMode: string): boolean {
  if (cls === 'r') return ptMode === 'rail';
  if (cls === 't') return ptMode === 'tram' || ptMode === 'metro';
  // Bus-Klasse: alles Strassen-/Wassergebundene, aber NIE Schiene — sonst
  // bekäme ein Bus-Paar die Geometrie eines parallelen Zugs.
  return ptMode !== 'rail' && ptMode !== 'tram' && ptMode !== 'metro';
}

function sloidTail(ref: string | null): string | null {
  return ref ? (/^ch:1:sloid:(\d+)/.exec(ref)?.[1] ?? null) : null;
}

/**
 * Extrahiert die Projektion des ersten TimedLeg, der (a) im richtigen
 * Verkehrsmittel fährt und (b) wirklich DIREKT von a nach b führt.
 * WICHTIG (Nutzer-Fund R24 Luzern): ohne Modus-Check bekam ein ZUG-Paar die
 * Geometrie der nächstbesten BUS-Verbindung — der Zug fuhr dann über Strassen.
 */
function extractProjection(delivery: Pt, cls: ModeClass, a: string, b: string): Segment | null {
  for (const r of arr(delivery.TripResult)) {
    for (const leg of arr((r as Pt).Trip?.Leg)) {
      const timed = (leg as Pt).TimedLeg;
      if (!timed) continue;
      const ptMode = txt(timed.Service?.Mode?.PtMode) ?? '';
      const boardKey = sloidTail(txt(timed.LegBoard?.StopPointRef));
      const alightKey = sloidTail(txt(timed.LegAlight?.StopPointRef));
      if (!modeMatches(cls, ptMode) || boardKey !== a || alightKey !== b) continue;
      const points: Segment = [];
      for (const section of arr(timed.LegTrack?.TrackSection)) {
        for (const p of arr((section as Pt).LinkProjection?.Position)) {
          const lon = Number(txt((p as Pt).Longitude));
          const lat = Number(txt((p as Pt).Latitude));
          if (Number.isFinite(lon) && Number.isFinite(lat)) points.push([lon, lat]);
        }
      }
      if (points.length >= 2) return points;
    }
  }
  return null;
}

/** Kurz-Key (sloid-Tail) → OJP-Ref. Ausländische UICs (nicht mappbar) → null. */
function keyToRef(key: string): string | null {
  if (!/^\d+$/.test(key)) return null;
  if (key.length >= 6) return null; // ausländische BPUIC — kein Schweizer sloid
  return `ch:1:sloid:${key}`;
}

async function fetchSegment(cls: ModeClass, a: string, b: string): Promise<Segment | null> {
  const refA = keyToRef(a);
  const refB = keyToRef(b);
  if (!refA || !refB) return null;
  const delivery = await ojpRequest(projectionTripRequest(cls, refA, refB), 'OJPTripDelivery');
  const raw = extractProjection(delivery as Pt, cls, a, b);
  if (!raw) return null;
  return simplify(raw).map(([lon, lat]) => [Math.round(lon * 1e5) / 1e5, Math.round(lat * 1e5) / 1e5]);
}

// ── Cache-Schichten + Budget ────────────────────────────────────────────────

const MISS = 'X'; // Marker: Paar ist nicht bepfadbar — nicht erneut anfragen.
const SEG_TTL = 60 * 86_400;
const MISS_TTL = 7 * 86_400;
const MEM_MAX = 6000;
const memSegs = new Map<string, Segment | null>(); // LRU (Insertion-Order)

function memRemember(key: string, value: Segment | null) {
  if (memSegs.size >= MEM_MAX) {
    const oldest = memSegs.keys().next().value;
    if (oldest !== undefined) memSegs.delete(oldest);
  }
  memSegs.set(key, value);
}

/**
 * Liefert Segmente für Paare im Format "<cls>:keyA-keyB" (cls: r|t|b).
 * Unbekannte werden bis maxFetch Stück live von OJP geholt (zählt ins
 * OTD-Tagesbudget), der Rest bleibt in dieser Antwort weg — der Client
 * fragt später erneut.
 */
export async function getSegments(
  pairs: string[],
  maxFetch = 5,
): Promise<Record<string, Segment | null>> {
  const out: Record<string, Segment | null> = {};
  let fetched = 0;
  for (const pair of pairs) {
    if (memSegs.has(pair)) {
      out[pair] = memSegs.get(pair) ?? null;
      continue;
    }
    const cachedVal = await cacheGet<Segment | typeof MISS>(`shape2:${pair}`);
    if (cachedVal !== undefined) {
      const seg = cachedVal === MISS ? null : (cachedVal as Segment);
      memRemember(pair, seg);
      out[pair] = seg;
      continue;
    }
    if (fetched >= maxFetch) continue; // später wieder — Client pollt erneut
    if (!(await underMinuteCap(1))) break; // Minuten-Deckel erreicht → Rest später
    fetched++;
    const m = /^([rtb]):(\d+)-(\d+)$/.exec(pair);
    if (!m) {
      out[pair] = null;
      continue;
    }
    try {
      const seg = await fetchSegment(m[1] as ModeClass, m[2], m[3]);
      memRemember(pair, seg);
      out[pair] = seg;
      await cachePut(`shape2:${pair}`, seg ? SEG_TTL : MISS_TTL, seg ?? MISS);
    } catch (err) {
      // Quota/Rate-Limit: fürs Erste aufhören (kein Miss-Marker — später erneut).
      if (err instanceof OjpError && (err.code === 'quota' || err.status === 429)) break;
    }
  }
  return out;
}
