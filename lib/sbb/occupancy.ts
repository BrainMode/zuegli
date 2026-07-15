// Belegungsprognose (CAPRE): „Wie voll wird mein Zug?" — pro Abschnitt und
// Klasse. Nur SBB/BLS/Thurbo/SOB liefern Daten.
//
// Das ist KEINE Abfrage-API, sondern ein täglich publizierter CKAN-Datensatz
// (eine JSON-Datei pro Betreiber und Tag, ohne Auth). Wir cachen die geparste
// Datei in-memory pro Instanz und das Ergebnis pro Zug im geteilten Cache.

const CKAN_BASE = 'https://data.opentransportdata.swiss/api/3/action';
const DATASET = 'occupancy-forecast-json-dataset';

// operatorRef laut Cookbook: 11=SBB, 33=BLS, 65=Thurbo, 82=SOB.
const OPERATORS: Array<{ ref: string; name: string }> = [
  { ref: '11', name: 'SBB' },
  { ref: '65', name: 'Thurbo' },
  { ref: '33', name: 'BLS' },
  { ref: '82', name: 'SOB' },
];

const LEVEL_LABELS: Record<string, string> = {
  manySeatsAvailable: 'viele freie Plätze',
  fewSeatsAvailable: 'wenige freie Plätze',
  standingRoomOnly: 'nur noch Stehplätze',
  lowOccupancy: 'schwach belegt',
  unknown: 'unbekannt',
};

type Json = Record<string, any>;

type OccSection = {
  from: string;
  to: string;
  departure: string | null;
  firstClass: string | null;
  secondClass: string | null;
};

export type OccupancyResult =
  | { operator: string; trainNumber: string; date: string; sections: OccSection[] }
  | { error: string; hint?: string };

// In-Memory-Cache der (potenziell MB-grossen) Tagesdateien — pro Instanz,
// max. 2 Dateien, 30 min. Zu gross für Redis; das Ergebnis pro Zug landet
// dagegen im geteilten cached() der Actions-Schicht.
const fileCache = new Map<string, { exp: number; trains: Map<string, Json> }>();

async function fetchJson(url: string): Promise<Json> {
  const res = await fetch(url, {
    headers: { Accept: 'application/json', 'User-Agent': 'zuegli (open-source)' },
    signal: AbortSignal.timeout(20_000),
  });
  if (!res.ok) throw new Error(`CKAN HTTP ${res.status}`);
  return (await res.json()) as Json;
}

/** Findet die Download-URL der Tagesdatei eines Betreibers über package_show. */
async function resourceUrl(operatorRef: string, date: string): Promise<string | null> {
  const pkg = await fetchJson(`${CKAN_BASE}/package_show?id=${DATASET}`);
  const resources: Json[] = Array.isArray(pkg?.result?.resources) ? pkg.result.resources : [];
  // Dateinamen-Muster: {operatorRef}_{operationDate}.json (Trennzeichen defensiv).
  const needle = new RegExp(`(^|[^0-9])${operatorRef}[_-]${date}`, 'i');
  const hit = resources.find(
    (r) => needle.test(String(r.name ?? '')) || needle.test(String(r.url ?? '')),
  );
  return hit?.url ?? null;
}

async function trainsOf(operatorRef: string, date: string): Promise<Map<string, Json> | null> {
  const key = `${operatorRef}:${date}`;
  const hit = fileCache.get(key);
  if (hit && hit.exp > Date.now()) return hit.trains;

  const url = await resourceUrl(operatorRef, date);
  if (!url) return null;
  const data = await fetchJson(url);
  const trains = new Map<string, Json>();
  for (const t of Array.isArray(data?.trains) ? data.trains : []) {
    if (t?.trainNumber != null) trains.set(String(t.trainNumber).replace(/^0+/, ''), t);
  }
  if (fileCache.size >= 2) {
    const oldest = fileCache.keys().next().value;
    if (oldest) fileCache.delete(oldest);
  }
  fileCache.set(key, { exp: Date.now() + 30 * 60_000, trains });
  return trains;
}

function levelOf(section: Json, fareClass: string): string | null {
  const list: Json[] = Array.isArray(section?.expectedDepartureOccupancy)
    ? section.expectedDepartureOccupancy
    : [];
  const hit = list.find((o) => o?.fareClass === fareClass);
  return hit ? (LEVEL_LABELS[String(hit.occupancyLevel)] ?? String(hit.occupancyLevel)) : null;
}

/** Belegungsprognose eines Zuges (Zugnummer + Datum), über alle 4 Betreiber gesucht. */
export async function occupancyForecast(
  trainNumber: string,
  date: string,
): Promise<OccupancyResult> {
  const num = trainNumber.replace(/\D/g, '').replace(/^0+/, '');
  if (!num) {
    return { error: 'zugnummer', hint: `„${trainNumber}" enthält keine Zugnummer (nur Ziffern).` };
  }
  for (const op of OPERATORS) {
    try {
      const trains = await trainsOf(op.ref, date);
      const train = trains?.get(num);
      if (!train) continue;
      const sections: OccSection[] = (Array.isArray(train.sections) ? train.sections : [])
        .slice(0, 12)
        .map((s: Json) => ({
          from: s.departureStationName ?? '?',
          to: s.destinationStationName ?? '?',
          departure: s.departureTime ? String(s.departureTime).slice(0, 5) : null,
          firstClass: levelOf(s, 'firstClass'),
          secondClass: levelOf(s, 'secondClass'),
        }));
      return { operator: op.name, trainNumber: num, date, sections };
    } catch {
      // Betreiber-Datei nicht verfügbar → nächsten probieren.
    }
  }
  return {
    error: 'nicht_gefunden',
    hint: `Für Zug ${num} am ${date} gibt es keine Belegungsprognose (nur SBB, BLS, Thurbo und SOB; Prognose „heute-fokussiert").`,
  };
}
