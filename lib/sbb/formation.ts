// Train Formation Service v2 (Wagenreihung) — DAS Schweiz-Feature, das die DB
// öffentlich nicht hat: Wagenreihenfolge inkl. PERRONSEKTOR pro Wagen und Halt,
// Klasse, Rollstuhlplätze, Velohaken, Speisewagen …
//
// GET https://api.opentransportdata.swiss/formation/v2/formations_full
//     ?evu=SBBP&operationDate=YYYY-MM-DD&trainNumber=NNN   (Bearer-Auth)
//
// HINWEIS: Feld-Enumerationen (amenities/class) nach Erhalt echter Keys im
// Smoke-Test verifizieren; der Code ist defensiv (Optional Chaining, tolerante
// Feldzugriffe) — Muster wie official.ts der DB-Schwester-App.

import { otdGet, OjpError } from './client';

const FORMATION_BASE =
  process.env.OTD_FORMATION_BASE ?? 'https://api.opentransportdata.swiss/formation/v2';

// EVUs mit Formationsdaten; SBBP zuerst, dann die wahrscheinlichsten anderen.
const EVU_FALLBACKS = ['SBBP', 'THURBO', 'BLSP', 'SOB'] as const;
export const EVU_LIST = [
  'SBBP', 'BLSP', 'THURBO', 'SOB', 'RhB', 'ZB', 'MBC', 'OeBB', 'TPF', 'TRN', 'VDBB',
] as const;

type Json = Record<string, any>;

function key(): string | undefined {
  return process.env.OTD_FORMATION_KEY ?? process.env.OTD_API_KEY;
}

async function fetchFormation(evu: string, operationDate: string, trainNumber: string): Promise<Json> {
  const url = `${FORMATION_BASE}/formations_full?evu=${encodeURIComponent(evu)}&operationDate=${encodeURIComponent(operationDate)}&trainNumber=${encodeURIComponent(trainNumber)}`;
  const res = await otdGet(url, { key: key() });
  return (await res.json()) as Json;
}

/** Wagen-Ausstattungscodes → deutsche Labels (defensiv; unbekannte Codes roh durchreichen). */
const AMENITY_LABELS: Record<string, string> = {
  BHP: 'Rollstuhlplätze',
  NF: 'Niederflureinstieg',
  VH: 'Velohaken',
  VR: 'Veloplätze (Reservierung)',
  WR: 'Speisewagen',
  BZ: 'Businesszone',
  FZ: 'Familienzone',
  FA: 'Familienwagen',
  KW: 'Stillabteil',
  CC: 'Couchettes',
  WL: 'Schlafwagen',
};

function amenityLabel(code: unknown): string {
  const c = String(code ?? '').trim();
  return AMENITY_LABELS[c] ?? c;
}

export type FormationResult =
  | {
      evu: string;
      train: string;
      cars: Array<{
        position: number | null;
        type: string | null;
        class: string | null;
        amenities: string[];
      }>;
      stops: Array<{
        name: string;
        track: string | null;
        sectors: string | null;
      }>;
    }
  | { error: string; hint?: string };

/**
 * Wagenreihung eines Zuges. Probiert ohne EVU-Angabe die üblichen EVUs durch
 * (SBB zuerst) — jede Probe ist ein Request, deshalb kurze Fallback-Liste.
 */
export async function formation(
  trainNumber: string,
  operationDate: string,
  evu?: string,
): Promise<FormationResult> {
  if (!key()) {
    return {
      error: 'nicht_konfiguriert',
      hint:
        'Die Wagenreihung ist noch nicht aktiviert — dafür fehlt der (kostenlose) API-Key von opentransportdata.swiss.',
    };
  }
  const num = trainNumber.replace(/\D/g, '');
  if (!num) {
    return { error: 'zugnummer', hint: `„${trainNumber}" enthält keine Zugnummer (nur Ziffern).` };
  }

  const evus = evu ? [evu] : [...EVU_FALLBACKS];
  let lastErr: unknown = null;
  for (const e of evus) {
    try {
      const data = await fetchFormation(e, operationDate, num);
      const parsed = parseFormation(e, num, data);
      if (parsed) return parsed;
    } catch (err) {
      lastErr = err;
      // 404/leer → nächstes EVU probieren; harte Fehler durchreichen.
      if (err instanceof OjpError && err.status != null && err.status !== 404 && err.status < 500) {
        break;
      }
    }
  }
  if (lastErr instanceof OjpError && lastErr.code === 'quota') throw lastErr;
  return {
    error: 'nicht_gefunden',
    hint: `Für Zug ${num} am ${operationDate} sind keine Formationsdaten verfügbar (nur teilnehmende Bahnen, max. 3 Tage im Voraus).`,
  };
}

function parseFormation(evu: string, trainNumber: string, data: Json): FormationResult | null {
  const stops = asArray(data.scheduledStops);
  const vehicles = asArray(data.formationVehicles ?? data.vehicles);
  if (stops.length === 0 && vehicles.length === 0) return null;

  return {
    evu,
    train: [data.trainMetaInformation?.trainType, data.trainMetaInformation?.lineText ?? trainNumber]
      .filter(Boolean)
      .join(' ') || trainNumber,
    cars: vehicles.slice(0, 20).map((v: Json) => {
      const p = v.vehicleProperties ?? v;
      return {
        position: p.orderNumber != null ? Number(p.orderNumber) : null,
        type: p.vehicleTypeKI ?? p.type ?? null,
        class: p.class != null ? String(p.class) : null,
        amenities: asArray(p.amenities).map(amenityLabel),
      };
    }),
    stops: stops.slice(0, 12).map((s: Json) => ({
      name: s.stopPoint?.name ?? '?',
      track: s.track?.text ?? null,
      // Kompakter CUS-String: Sektorlage der Wagen an diesem Halt.
      sectors: s.formationShortString ?? null,
    })),
  };
}

function asArray(x: unknown): Json[] {
  return Array.isArray(x) ? x : [];
}
