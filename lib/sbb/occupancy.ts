// Belegungsprognose (CAPRE): „Wie voll wird mein Zug?" — pro Abschnitt und
// Klasse. Nur SBB/BLS/Thurbo/SOB (+ weitere teilnehmende) liefern Daten.
//
// Das ist KEINE Abfrage-API: opentransportdata.swiss publiziert täglich EIN
// ZIP (~140 MB) mit einer JSON-Datei pro Betreiber und Tag. Viel zu schwer
// für den Request-Pfad — deshalb lädt ein täglicher Cron (/api/cron/occupancy)
// das ZIP, kompaktiert pro Zug und legt pro Betreiber+Tag EINEN gzip/base64-
// Blob in den Cache (SBB kompakt: ~350 KB gzip statt 39 MB roh).
// occupancyForecast() liest dann nur noch diese Blobs (mit In-Memory-Cache
// pro Instanz).
//
// Verifiziert gegen echte Daten (2026-07-15): Feld heisst
// `expectedDepartureOccupancies` (Plural!), Levels manySeatsAvailable /
// fewSeatsAvailable / standingRoomOnly / unknown.

import { gzipSync, gunzipSync, unzipSync, strFromU8, strToU8 } from 'fflate';
import { cachePut, cacheGet } from '../cache';

const DATASET_PAGE =
  process.env.OTD_OCCUPANCY_DATASET_URL ??
  'https://data.opentransportdata.swiss/dataset/occupancy-forecast-json-dataset';

// operatorRef laut Cookbook/Dateinamen: 11=SBB, 33=BLS, 65=Thurbo, 82=SOB, 86=?
const OPERATORS: Array<{ ref: string; name: string }> = [
  { ref: '11', name: 'SBB' },
  { ref: '65', name: 'Thurbo' },
  { ref: '33', name: 'BLS' },
  { ref: '82', name: 'SOB' },
  { ref: '86', name: 'weitere' },
];

const LEVEL_LABELS: Record<string, string> = {
  m: 'viele freie Plätze',
  f: 'wenige freie Plätze',
  s: 'nur noch Stehplätze',
  l: 'schwach belegt',
  u: 'unbekannt',
};
const LEVEL_CODE: Record<string, string> = {
  manySeatsAvailable: 'm',
  fewSeatsAvailable: 'f',
  standingRoomOnly: 's',
  lowOccupancy: 'l',
  unknown: 'u',
};

type Json = Record<string, any>;

// Kompaktformat pro Zug: [from, to, "HH:MM", firstClassCode, secondClassCode][]
type CompactSections = Array<[string, string, string, string, string]>;
type CompactFile = Record<string, CompactSections>;

// ── Cron-Seite: ZIP laden, kompaktieren, Blobs schreiben ────────────────────

/** Findet die aktuelle ZIP-URL über die (stabile) Dataset-Seite. */
async function findZipUrl(): Promise<string> {
  const res = await fetch(DATASET_PAGE, {
    headers: { 'User-Agent': 'Mozilla/5.0 zuegli (open-source)' },
    signal: AbortSignal.timeout(20_000),
  });
  if (!res.ok) throw new Error(`Dataset-Seite HTTP ${res.status}`);
  const html = await res.text();
  const m = /href="(https:\/\/data\.opentransportdata\.swiss\/[^"]*\/download\/[^"]*\.zip)"/i.exec(html);
  if (!m) throw new Error('Keine ZIP-Download-URL auf der Dataset-Seite gefunden');
  return m[1];
}

function compactTrains(data: Json): CompactFile {
  const out: CompactFile = {};
  for (const t of Array.isArray(data?.trains) ? data.trains : []) {
    const num = String(t?.trainNumber ?? '').replace(/^0+/, '');
    if (!num) continue;
    const sections: CompactSections = [];
    for (const s of Array.isArray(t.sections) ? t.sections : []) {
      const occ: Record<string, string> = {};
      // Real: expectedDepartureOccupancies (Cookbook nennt es ohne "ies").
      const list = s.expectedDepartureOccupancies ?? s.expectedDepartureOccupancy ?? [];
      for (const o of Array.isArray(list) ? list : []) {
        occ[String(o?.fareClass)] = LEVEL_CODE[String(o?.occupancyLevel)] ?? 'u';
      }
      sections.push([
        String(s.departureStationName ?? '?'),
        String(s.destinationStationName ?? '?'),
        String(s.departureTime ?? '').slice(0, 5),
        occ.firstClass ?? 'u',
        occ.secondClass ?? 'u',
      ]);
    }
    if (sections.length) out[num] = sections;
  }
  return out;
}

/**
 * Lädt das Tages-ZIP und schreibt pro Betreiber+Tag einen kompakten Blob in
 * den Cache (36 h TTL). Wird vom täglichen Cron aufgerufen — NICHT im
 * Request-Pfad verwenden (~140 MB Download).
 */
export async function refreshOccupancyData(): Promise<{
  zipUrl: string;
  written: Array<{ date: string; operator: string; trains: number; blobKB: number }>;
}> {
  const zipUrl = await findZipUrl();
  const res = await fetch(zipUrl, {
    headers: { 'User-Agent': 'Mozilla/5.0 zuegli (open-source)' },
    signal: AbortSignal.timeout(240_000),
  });
  if (!res.ok) throw new Error(`ZIP HTTP ${res.status}`);
  const zipBytes = new Uint8Array(await res.arrayBuffer());

  // Nur heute + morgen entpacken (Dateinamen: YYYY-MM-DD/operator-NN.json).
  const today = new Date().toLocaleDateString('sv-SE', { timeZone: 'Europe/Zurich' });
  const tomorrow = new Date(Date.now() + 86_400_000).toLocaleDateString('sv-SE', {
    timeZone: 'Europe/Zurich',
  });
  const wanted = new RegExp(`^(${today}|${tomorrow})/operator-(\\d+)\\.json$`);
  const files = unzipSync(zipBytes, { filter: (f) => wanted.test(f.name) });

  const written: Array<{ date: string; operator: string; trains: number; blobKB: number }> = [];
  for (const [name, bytes] of Object.entries(files)) {
    const m = wanted.exec(name);
    if (!m) continue;
    const [, date, op] = m;
    const compact = compactTrains(JSON.parse(strFromU8(bytes)) as Json);
    const blob = Buffer.from(gzipSync(strToU8(JSON.stringify(compact)), { level: 6 })).toString('base64');
    await cachePut(`occz:${date}:${op}`, 36 * 3600, blob);
    written.push({
      date,
      operator: op,
      trains: Object.keys(compact).length,
      blobKB: Math.round(blob.length / 1024),
    });
  }
  return { zipUrl, written };
}

// ── Lese-Seite: Blob → In-Memory-Map → Zug nachschlagen ─────────────────────

const memBlobs = new Map<string, { exp: number; trains: CompactFile | null }>();

async function operatorTrains(op: string, date: string): Promise<CompactFile | null> {
  const key = `${op}:${date}`;
  const hit = memBlobs.get(key);
  if (hit && hit.exp > Date.now()) return hit.trains;

  const blob = await cacheGet<string>(`occz:${date}:${op}`);
  let trains: CompactFile | null = null;
  if (blob) {
    try {
      trains = JSON.parse(strFromU8(gunzipSync(Buffer.from(blob, 'base64')))) as CompactFile;
    } catch {
      trains = null;
    }
  }
  if (memBlobs.size >= 12) {
    const oldest = memBlobs.keys().next().value;
    if (oldest) memBlobs.delete(oldest);
  }
  memBlobs.set(key, { exp: Date.now() + 30 * 60_000, trains });
  return trains;
}

type OccSection = {
  from: string;
  to: string;
  departure: string | null;
  firstClass: string;
  secondClass: string;
};

export type OccupancyResult =
  | { operator: string; trainNumber: string; date: string; sections: OccSection[] }
  | { error: string; hint?: string };

/** Belegungsprognose eines Zuges (Zugnummer + Datum), über alle Betreiber gesucht. */
export async function occupancyForecast(
  trainNumber: string,
  date: string,
): Promise<OccupancyResult> {
  const num = trainNumber.replace(/\D/g, '').replace(/^0+/, '');
  if (!num) {
    return { error: 'zugnummer', hint: `„${trainNumber}" enthält keine Zugnummer (nur Ziffern).` };
  }

  let anyData = false;
  for (const op of OPERATORS) {
    const trains = await operatorTrains(op.ref, date);
    if (!trains) continue;
    anyData = true;
    const sections = trains[num];
    if (!sections) continue;
    return {
      operator: op.name,
      trainNumber: num,
      date,
      sections: sections.slice(0, 12).map(([from, to, dep, first, second]) => ({
        from,
        to,
        departure: dep || null,
        firstClass: LEVEL_LABELS[first] ?? 'unbekannt',
        secondClass: LEVEL_LABELS[second] ?? 'unbekannt',
      })),
    };
  }

  if (!anyData) {
    return {
      error: 'keine_daten',
      hint:
        'Die Belegungsdaten für diesen Tag sind (noch) nicht geladen — der tägliche Datenimport läuft noch nicht oder Redis ist nicht konfiguriert. Prognosen gibt es zudem nur für heute/morgen.',
    };
  }
  return {
    error: 'nicht_gefunden',
    hint: `Für Zug ${num} am ${date} gibt es keine Belegungsprognose (nur SBB, BLS, Thurbo, SOB).`,
  };
}
