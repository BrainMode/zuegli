// Live-Karten-Pipeline: SIRI-ET (Landes-Snapshot aller ÖV-Fahrten, ~40–100 MB
// XML, KEINE Koordinaten) → Chunk-Parse → Koordinaten-Join via Stops-Index →
// 4 kompakte, gzip-komprimierte Tier-Snapshots. Der Client interpoliert
// Positionen aus den absoluten Halt-Zeiten (Luftlinie zwischen Halten, v1).
//
// Tiers (zoomgestuft ladbar): 1 Fernverkehr-rail, 2 Regio-rail, 3 tram/metro,
// 4 bus/übrige.
//
// Architektur (seit 11/2026): Der Snapshot wird ON DEMAND in der Instanz
// gebaut, die /api/trains bedient (~5 s), und dort für MIN_INTERVAL_SEC
// gemerkt (nachts 5 min). Vorher schrieb ein Minuten-Cron jede Minute ~2.7 MB
// (doppelt, mit Stale-Kopie) nach Upstash — ~7 GB/Tag gegen 10 GB/Monat im
// Free-Tier; die gesperrte Datenbank hat dann Chat und Karte lahmgelegt.
// Jetzt: kein Redis, kein Cron, und ohne Kartenbesucher auch kein SIRI-ET-Abruf.
// Ältere Snapshots (< 30 min) werden sofort ausgeliefert, während im
// Hintergrund neu gebaut wird (stale-while-revalidate, via waitUntil).

import { waitUntil } from '@vercel/functions';
import { gzipSync, gunzipSync, strFromU8, strToU8 } from 'fflate';
import { ojpParser, arr, txt } from './client';
import { loadStopIndex, resolveStop, stopKey, type StopIndex } from './stops';

const SIRI_ET_URL = process.env.OTD_SIRIET_URL ?? 'https://api.opentransportdata.swiss/la/siri-et';
const MIN_INTERVAL_SEC = Number(process.env.LIVEMAP_MIN_INTERVAL_SEC ?? 55);
const NIGHT_INTERVAL_SEC = 300;
const STALE_MAX_SEC = 30 * 60;
const RETRY_AFTER_FAILURE_MS = 30_000;
const WINDOW_PAST_SEC = 10 * 60;
const WINDOW_FUTURE_SEC = 60 * 60;
// Payload-Bremse für den Client: Tier 4 (Busse) wird sonst > 3 MB pro Abruf.
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
  ni?: number; // Index des Calls, auf den sich ns/dl beziehen (Client prüft Frische)
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

// Der Feed erlaubt 2 Abrufe pro Minute und Key (X-Ratelimit-Limit: 2).
// Bauen zwei kalte Instanzen gleichzeitig, bekommt die dritte 429 — dann bis
// zum gemeldeten Reset warten (Fenster 60 s → max. 65 s; maxDuration der Route
// ist 120 s) und einmal neu versuchen, statt dem Client 503 zu liefern.
const MAX_429_WAIT_MS = 65_000;

async function fetchSiriEt(retryOn429 = true): Promise<string> {
  const key = process.env.OTD_SIRIET_KEY;
  if (!key) throw new Error('OTD_SIRIET_KEY fehlt');
  // Bewusst KEIN otdGet: Karten-Abrufe dürfen das geteilte OJP-Tagesbudget
  // nicht verbrauchen; der Feed hat sein eigenes Kontingent.
  const res = await fetch(SIRI_ET_URL, {
    headers: {
      Authorization: `Bearer ${key}`,
      'User-Agent': 'zuegli (open-source; github.com/BrainMode/zuegli)',
    },
    signal: AbortSignal.timeout(120_000),
  });
  if (res.status === 429 && retryOn429) {
    const reset = Number(res.headers.get('x-ratelimit-reset'));
    const waitMs = Number.isFinite(reset) && reset > 0 ? reset * 1000 - Date.now() + 500 : 20_000;
    await res.body?.cancel();
    if (waitMs <= MAX_429_WAIT_MS) {
      await new Promise((r) => setTimeout(r, Math.max(waitMs, 1000)));
      return fetchSiriEt(false);
    }
  }
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
  let ni: number | undefined;
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
      ni = calls.length - 1; // Index dieses Calls im kompakten Array
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
    ...(ni !== undefined ? { ni } : {}),
    c: calls,
  };
}

type TierNum = 1 | 2 | 3 | 4;
type Snapshot = {
  t: number; // Unix-Sekunden des Baus (Client zeigt "veraltet" ab 180 s)
  tiers: Record<TierNum, { gz: Uint8Array; trains: LiveTrain[] }>;
};

function encodeTier(tier: LiveTier): Uint8Array {
  return gzipSync(strToU8(JSON.stringify(tier)), { level: 6 });
}

function zurichMinutes(now: Date): number {
  const zurich = new Date(now.toLocaleString('sv-SE', { timeZone: 'Europe/Zurich' }).replace(' ', 'T'));
  return zurich.getHours() * 60 + zurich.getMinutes();
}

/** Maximales Snapshot-Alter: 01:00–04:30 kaum Verkehr → 5 min, sonst ~1 min. */
function maxAgeSec(now: Date): number {
  const mins = zurichMinutes(now);
  return mins >= 60 && mins < 270 ? NIGHT_INTERVAL_SEC : MIN_INTERVAL_SEC;
}

async function buildSnapshot(): Promise<Snapshot> {
  const started = Date.now();
  const stops = await loadStopIndex();
  if (!stops) throw new Error('Stops-Index nicht verfügbar (Quelle und Cache leer)');

  const xml = await fetchSiriEt();
  // Zeitbasis NACH dem Abruf (ein 429-Retry kann bis zu einer Minute warten).
  const nowSec = Math.round(Date.now() / 1000);
  const buckets: Record<TierNum, LiveTrain[]> = { 1: [], 2: [], 3: [], 4: [] };
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

  const tiers = {} as Snapshot['tiers'];
  const stats: Record<string, { trains: number; kB: number }> = {};
  for (const t of [1, 2, 3, 4] as const) {
    let trains = buckets[t];
    let gz = encodeTier({ t: nowSec, trains });
    if (gz.length > BLOB_LIMIT) {
      // Zukunftsfenster schrumpfen, damit der Client nicht Megabytes pro Minute lädt.
      trains = trains
        .map((tr) => ({ ...tr, c: tr.c.filter(([, , a]) => a <= nowSec + 40 * 60) }))
        .filter((tr) => tr.c.length >= 2);
      gz = encodeTier({ t: nowSec, trains });
    }
    tiers[t] = { gz, trains };
    stats[`t${t}`] = { trains: trains.length, kB: Math.round(gz.length / 1024) };
  }
  console.log('[livemap] Snapshot gebaut', JSON.stringify({ journeys, mapped, ms: Date.now() - started, ...stats }));
  return { t: nowSec, tiers };
}

// ── Snapshot-Verwaltung pro Instanz ─────────────────────────────────────────

let current: Snapshot | null = null;
let building: Promise<Snapshot> | null = null;
let lastFailure = 0;

function startBuild(): Promise<Snapshot> | null {
  if (building) return building;
  if (Date.now() - lastFailure < RETRY_AFTER_FAILURE_MS) return null;
  building = buildSnapshot()
    .then((s) => {
      current = s;
      return s;
    })
    .catch((err) => {
      lastFailure = Date.now();
      console.error('[livemap] Snapshot-Bau fehlgeschlagen:', err instanceof Error ? err.message : err);
      throw err;
    })
    .finally(() => {
      building = null;
    });
  return building;
}

/**
 * Aktueller Snapshot: frisch aus dem Speicher, sonst älterer (< 30 min) sofort
 * plus Neubau im Hintergrund, sonst Neubau abwarten. null = keine Daten.
 */
async function getSnapshot(): Promise<Snapshot | null> {
  const age = current ? Date.now() / 1000 - current.t : Infinity;
  if (current && age < maxAgeSec(new Date())) return current;

  const job = startBuild();
  if (current && age < STALE_MAX_SEC) {
    if (job) waitUntil(job.catch(() => undefined));
    return current;
  }
  if (!job) return null; // letzter Bau scheiterte vor < 30 s und nichts Brauchbares im Speicher
  try {
    return await job;
  } catch {
    return null;
  }
}

// ── Lese-Seite (API-Route) ──────────────────────────────────────────────────

/** gzip-Bytes eines Tiers — für gzip-Pass-through in /api/trains. */
export async function readTier(t: TierNum): Promise<Uint8Array | null> {
  const snap = await getSnapshot();
  return snap ? snap.tiers[t].gz : null;
}

/** Einzelnen Zug per journeyRef(-Prefix) über alle Tiers suchen (für Chat-Karten). */
export async function findTrain(refPrefix: string): Promise<{ t: number; train: LiveTrain } | null> {
  const snap = await getSnapshot();
  if (!snap) return null;
  for (const t of [1, 2, 3, 4] as const) {
    const trains = snap.tiers[t].trains;
    const train =
      trains.find((tr) => tr.r === refPrefix) ??
      trains.find((tr) => tr.r.startsWith(refPrefix) || refPrefix.startsWith(tr.r));
    if (train) return { t: snap.t, train };
  }
  return null;
}
