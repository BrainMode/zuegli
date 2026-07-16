// Live-Karten-Pipeline: SIRI-ET (Landes-Snapshot aller ÖV-Fahrten, ~40–100 MB
// XML, KEINE Koordinaten) → Chunk-Parse → Koordinaten-Join via Stops-Index →
// 4 kompakte Tier-Blobs in Redis. Der Client interpoliert Positionen aus den
// absoluten Halt-Zeiten (Luftlinie zwischen Halten, v1).
//
// Tiers (zoomgestuft ladbar): 1 Fernverkehr-rail, 2 Regio-rail, 3 tram/metro,
// 4 bus/übrige. Läuft im Minuten-Cron — Kosten-Bremsen: Nachtdrossel
// (01:00–04:30 nur jeder 5. Lauf), Overlap-Guard/Kadenz via
// LIVEMAP_MIN_INTERVAL_SEC (Default 55 s; Feed-Policy erlaubt 30 s).

import { gzipSync, gunzipSync, strFromU8, strToU8 } from 'fflate';
import { cachePut, cacheGet } from '../cache';
import { ojpParser, arr, txt } from './client';
import { loadStopIndex, resolveStop, stopKey, type StopIndex } from './stops';

const SIRI_ET_URL = process.env.OTD_SIRIET_URL ?? 'https://api.opentransportdata.swiss/la/siri-et';
const MIN_INTERVAL_SEC = Number(process.env.LIVEMAP_MIN_INTERVAL_SEC ?? 55);
const WINDOW_PAST_SEC = 10 * 60;
const WINDOW_FUTURE_SEC = 60 * 60;
const BLOB_LIMIT = 900 * 1024;

// 5. Element: kanonischer Halt-Key (sloid-Tail) — Join-Key für Fahrweg-Segmente.
export type LiveCall = [lon: number, lat: number, arr: number, dep: number, key: string];
export type LiveTrain = {
  r: string;
  l: string;
  n: string | null;
  d: string;
  m: 1 | 2 | 3 | 4;
  x?: 1;
  dl?: number;
  ns?: string;
  c: LiveCall[];
};
export type LiveTier = { t: number; trains: LiveTrain[] };

const FERN_RE = /^(IC|ICE|EC|IR|RJ|RJX|TGV|NJ|EN|PE)\s?\d*$/i;

function classify(mode: string, line: string, product: string): 1 | 2 | 3 | 4 {
  if (mode === 'tram' || mode === 'metro') return 3;
  if (mode === 'rail') {
    return FERN_RE.test(line.trim()) || FERN_RE.test(product.trim()) ? 1 : 2;
  }
  return 4; // bus, water, übrige
}

async function fetchSiriEt(): Promise<string> {
  const key = process.env.OTD_SIRIET_KEY;
  if (!key) throw new Error('OTD_SIRIET_KEY fehlt');
  // Bewusst KEIN otdGet: 1440 Läufe/Tag dürfen das geteilte OJP-Tagesbudget
  // nicht verbrauchen; der Feed hat sein eigenes Kontingent.
  const res = await fetch(SIRI_ET_URL, {
    headers: {
      Authorization: `Bearer ${key}`,
      'User-Agent': 'zuegli (open-source; github.com/BrainMode/zuegli)',
    },
    signal: AbortSignal.timeout(120_000),
  });
  if (!res.ok) throw new Error(`SIRI-ET HTTP ${res.status}`);
  const bytes = new Uint8Array(await res.arrayBuffer());
  return strFromU8(bytes[0] === 0x1f && bytes[1] === 0x8b ? gunzipSync(bytes) : bytes);
}

type Pt = Record<string, any>;

function epoch(iso: string | null): number | null {
  if (!iso) return null;
  const t = Date.parse(iso);
  return Number.isFinite(t) ? Math.round(t / 1000) : null;
}

/** Eine EstimatedVehicleJourney → LiveTrain (oder null, wenn nicht kartierbar). */
function compactJourney(j: Pt, stops: StopIndex, nowSec: number, futureSec: number): LiveTrain | null {
  const rawCalls = [
    ...arr(j.RecordedCalls?.RecordedCall),
    ...arr(j.EstimatedCalls?.EstimatedCall),
  ] as Pt[];
  if (rawCalls.length < 2) return null;

  const calls: LiveCall[] = [];
  let dl: number | undefined;
  let ns: string | undefined;
  for (const c of rawCalls) {
    const aimedArr = epoch(txt(c.AimedArrivalTime));
    const expArr = epoch(txt(c.ExpectedArrivalTime));
    const aimedDep = epoch(txt(c.AimedDepartureTime));
    const expDep = epoch(txt(c.ExpectedDepartureTime));
    const arrT = expArr ?? aimedArr;
    const depT = expDep ?? aimedDep;
    const a = arrT ?? depT;
    const d = depT ?? arrT;
    if (a == null || d == null) continue;
    if (d < nowSec - WINDOW_PAST_SEC || a > nowSec + futureSec) continue;
    const ref = txt(c.StopPointRef) ?? '';
    const pos = resolveStop(stops, ref);
    if (!pos) continue;
    const key = stopKey(ref) ?? '';
    const prev = calls[calls.length - 1];
    if (prev && key !== '' && prev[4] === key) {
      // Naht RecordedCalls/EstimatedCalls dupliziert den Grenzhalt → mergen
      // (frühere Ankunft behalten, spätere Abfahrt übernehmen).
      prev[3] = Math.max(prev[3], d);
      continue;
    }
    calls.push([pos[0], pos[1], a, d, key]);
    // Verspätung + nächster Halt: erster Call, der noch bevorsteht.
    if (ns === undefined && d >= nowSec) {
      ns = txt(c.StopPointName) ?? undefined;
      const aimed = aimedDep ?? aimedArr;
      const exp = expDep ?? expArr;
      if (aimed != null && exp != null) {
        const min = Math.round((exp - aimed) / 60);
        if (min !== 0) dl = min;
      }
    }
  }
  if (calls.length < 2) return null;

  const line = txt(j.PublishedLineName) ?? '?';
  const mode = txt(j.VehicleMode) ?? '';
  const product = (txt(j.ProductCategoryRef) ?? '').split(':').pop() ?? '';
  return {
    r: txt(j.FramedVehicleJourneyRef?.DatedVehicleJourneyRef) ?? '',
    l: line,
    n: txt(j.TrainNumbers?.TrainNumberRef),
    d: txt(j.DirectionName) ?? txt(j.DestinationName) ?? '?',
    m: classify(mode, line, product),
    ...(String(j.Cancellation) === 'true' ? { x: 1 as const } : {}),
    ...(dl !== undefined ? { dl } : {}),
    ...(ns !== undefined ? { ns } : {}),
    c: calls,
  };
}

function encodeTier(tier: LiveTier): string {
  return Buffer.from(gzipSync(strToU8(JSON.stringify(tier)), { level: 6 })).toString('base64');
}

function inNightThrottle(now: Date): boolean {
  const zurich = new Date(now.toLocaleString('sv-SE', { timeZone: 'Europe/Zurich' }).replace(' ', 'T'));
  const mins = zurich.getHours() * 60 + zurich.getMinutes();
  // 01:00–04:30: kaum Verkehr → nur jeder 5. Lauf.
  return mins >= 60 && mins < 270 && zurich.getMinutes() % 5 !== 0;
}

export async function refreshLiveMap(): Promise<{
  skipped?: string;
  journeys?: number;
  mapped?: number;
  tiers?: Record<string, { trains: number; blobKB: number }>;
}> {
  const nowSec = Math.round(Date.now() / 1000);
  if (inNightThrottle(new Date())) return { skipped: 'nachtdrossel' };

  const last = await cacheGet<number>('livemap:last');
  if (last && nowSec - last < MIN_INTERVAL_SEC) return { skipped: `overlap (${nowSec - last}s)` };
  await cachePut('livemap:last', 300, nowSec);

  const stops = await loadStopIndex();
  if (!stops) {
    throw new Error('Stops-Index fehlt — zuerst /api/cron/stops laufen lassen');
  }

  const xml = await fetchSiriEt();
  const buckets: Record<1 | 2 | 3 | 4, LiveTrain[]> = { 1: [], 2: [], 3: [], 4: [] };
  let journeys = 0;
  let mapped = 0;
  const re = /<EstimatedVehicleJourney>[\s\S]*?<\/EstimatedVehicleJourney>/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(xml)) !== null) {
    journeys++;
    try {
      const doc = ojpParser.parse(m[0]) as Pt;
      const train = compactJourney(doc?.EstimatedVehicleJourney ?? {}, stops, nowSec, WINDOW_FUTURE_SEC);
      if (train) {
        buckets[train.m].push(train);
        mapped++;
      }
    } catch {
      // einzelne kaputte Journey überspringen
    }
  }

  const tiers: Record<string, { trains: number; blobKB: number }> = {};
  for (const t of [1, 2, 3, 4] as const) {
    let tier: LiveTier = { t: nowSec, trains: buckets[t] };
    let blob = encodeTier(tier);
    if (blob.length > BLOB_LIMIT) {
      // Guard: Zukunftsfenster schrumpfen (Upstash 1 MB/Command).
      const shrunk = buckets[t]
        .map((tr) => ({ ...tr, c: tr.c.filter(([, , a]) => a <= nowSec + 40 * 60) }))
        .filter((tr) => tr.c.length >= 2);
      tier = { t: nowSec, trains: shrunk };
      blob = encodeTier(tier);
      console.warn(`[livemap] Tier ${t} > 900 KB — Fenster auf +40 min geschrumpft (${Math.round(blob.length / 1024)} KB)`);
    }
    await cachePut(`livemap:t${t}`, 300, blob);
    await cachePut(`livemap:stale:t${t}`, 1800, blob);
    tiers[`t${t}`] = { trains: tier.trains.length, blobKB: Math.round(blob.length / 1024) };
  }
  await cachePut('livemap:meta', 300, { t: nowSec, tiers });
  return { journeys, mapped, tiers };
}

// ── Lese-Seite (API-Route) ──────────────────────────────────────────────────

const memTiers = new Map<number, { exp: number; blob: string | null }>();

/** Roh-Blob (gzip/base64) eines Tiers — für gzip-Pass-through in /api/trains. */
export async function readTierBlob(t: 1 | 2 | 3 | 4): Promise<string | null> {
  const hit = memTiers.get(t);
  if (hit && hit.exp > Date.now()) return hit.blob;
  const blob =
    (await cacheGet<string>(`livemap:t${t}`)) ?? (await cacheGet<string>(`livemap:stale:t${t}`)) ?? null;
  memTiers.set(t, { exp: Date.now() + 20_000, blob });
  return blob;
}

export function decodeTier(blob: string): LiveTier {
  return JSON.parse(strFromU8(gunzipSync(Buffer.from(blob, 'base64')))) as LiveTier;
}

/** Einzelnen Zug per journeyRef(-Prefix) über alle Tiers suchen (für Chat-Karten). */
export async function findTrain(refPrefix: string): Promise<{ t: number; train: LiveTrain } | null> {
  for (const t of [1, 2, 3, 4] as const) {
    const blob = await readTierBlob(t);
    if (!blob) continue;
    const tier = decodeTier(blob);
    const train =
      tier.trains.find((tr) => tr.r === refPrefix) ??
      tier.trains.find((tr) => tr.r.startsWith(refPrefix) || refPrefix.startsWith(tr.r));
    if (train) return { t: tier.t, train };
  }
  return null;
}
