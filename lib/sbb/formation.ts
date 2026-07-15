// Train Formation Service v2 (Wagenreihung) — DAS Schweiz-Feature, das die DB
// öffentlich nicht hat: Wagenreihenfolge inkl. PERRONSEKTOR pro Wagen und Halt,
// Klasse, Sitzplätze, Rollstuhlplätze, Velohaken, Speisewagen …
//
// GET https://api.opentransportdata.swiss/formation/v2/formations_full
//     ?evu=SBBP&operationDate=YYYY-MM-DD&trainNumber=NNN   (Bearer-Auth)
//
// Response-Schema GEGEN ECHTE DATEN VERIFIZIERT (2026-07-15, IC 712) — weicht
// vom Cookbook ab: formationsAtScheduledStops[] (Halt + Gleis + CUS-String),
// formations[].formationVehicles[] mit number/position/vehicleProperties und
// je Halt `sectors` in formationVehicleAtScheduledStops[].

import { otdGet, OjpError } from './client';

const FORMATION_BASE =
  process.env.OTD_FORMATION_BASE ?? 'https://api.opentransportdata.swiss/formation/v2';

// EVUs mit Formationsdaten; SBBP zuerst, dann die wahrscheinlichsten anderen.
// ZB (Zentralbahn) liefert ebenfalls — z.B. Stans/Engelberg/Interlaken-Züge.
const EVU_FALLBACKS = ['SBBP', 'THURBO', 'BLSP', 'SOB', 'ZB'] as const;

type Json = Record<string, any>;

function key(): string | undefined {
  return process.env.OTD_FORMATION_KEY ?? process.env.OTD_API_KEY;
}

async function fetchFormation(evu: string, operationDate: string, trainNumber: string): Promise<Json> {
  const url = `${FORMATION_BASE}/formations_full?evu=${encodeURIComponent(evu)}&operationDate=${encodeURIComponent(operationDate)}&trainNumber=${encodeURIComponent(trainNumber)}`;
  const res = await otdGet(url, { key: key() });
  return (await res.json()) as Json;
}

type Car = {
  wagen: number | null;
  position: number | null;
  klasse: '1.' | '2.' | '1./2.' | null;
  sektor: string | null;
  ausstattung: string[];
};

export type FormationResult =
  | {
      evu: string;
      trainNumber: string;
      date: string;
      sektorenAmHalt: { name: string; gleis: string | null } | null;
      hinweis?: string;
      wagen: Car[];
      alleHalte: string[];
    }
  | { error: string; hint?: string };

function asArray(x: unknown): Json[] {
  return Array.isArray(x) ? x : [];
}

/** Ausstattung eines Wagens aus den (verifizierten) vehicleProperties ableiten. */
function carAmenities(p: Json): string[] {
  const out: string[] = [];
  if (Number(p.numberRestaurantSpace) > 0) out.push('Speisewagen');
  if (Number(p.numberBikeHooks) > 0) out.push(`Velohaken (${p.numberBikeHooks})`);
  const acc: Json = p.accessibilityProperties ?? {};
  if (Number(acc.numberWheelchairSpaces) > 0) out.push('Rollstuhlplätze');
  if (acc.wheelchairToilet === true) out.push('Rollstuhl-WC');
  const picto: Json = p.pictoProperties ?? {};
  if (picto.familyZonePicto === true) out.push('Familienzone');
  if (picto.businessZonePicto === true) out.push('Businesszone');
  if (picto.strollerPicto === true) out.push('Kinderwagenplatz');
  if (Number(p.numberBeds) > 0) out.push('Schlafwagen');
  return out;
}

function carClass(p: Json): Car['klasse'] {
  const first = Number(p.number1class) > 0;
  const second = Number(p.number2class) > 0;
  if (first && second) return '1./2.';
  if (first) return '1.';
  if (second) return '2.';
  return null; // Lok/Dienstwagen
}

/**
 * Wagenreihung eines Zuges. `stop` (Name-Substring) wählt den Halt, für den
 * die Sektoren gelten sollen — Default ist der erste Halt des Laufs.
 * Probiert ohne EVU-Angabe die üblichen EVUs durch (SBB zuerst).
 */
export async function formation(
  trainNumber: string,
  operationDate: string,
  evu?: string,
  stop?: string,
): Promise<FormationResult> {
  if (!key()) {
    return {
      error: 'nicht_konfiguriert',
      hint:
        'Die Wagenreihung ist noch nicht aktiviert — dafür fehlt der (kostenlose) API-Key von opentransportdata.swiss.',
    };
  }
  const num = trainNumber.replace(/\D/g, '').replace(/^0+/, '');
  if (!num) {
    return { error: 'zugnummer', hint: `„${trainNumber}" enthält keine Zugnummer (nur Ziffern).` };
  }

  const evus = evu ? [evu] : [...EVU_FALLBACKS];
  for (const e of evus) {
    try {
      const data = await fetchFormation(e, operationDate, num);
      const parsed = parseFormation(e, num, operationDate, data, stop);
      if (parsed) return parsed;
    } catch (err) {
      if (err instanceof OjpError) {
        if (err.code === 'quota' || err.code === 'nicht_konfiguriert') throw err;
        // 400 "There were no formation data." / 404 → nächstes EVU probieren.
        if (err.status === 400 || err.status === 404) continue;
        if (err.status === 401 || err.status === 403) throw err;
      }
      // transiente Fehler: nächstes EVU probieren
    }
  }
  const looksLikeLine = /[a-z]/i.test(trainNumber.trim());
  return {
    error: 'nicht_gefunden',
    hint:
      `Für Zug ${num} am ${operationDate} sind keine Formationsdaten verfügbar (v.a. Fernverkehr teilnehmender Bahnen).` +
      (looksLikeLine
        ? ` Hinweis: „${trainNumber}" sieht nach einer LINIE aus — nutze die ZUGNUMMER (Feld trainNumber aus getDepartures/planJourney/trackTrain).`
        : ''),
  };
}

function parseFormation(
  evu: string,
  trainNumber: string,
  date: string,
  data: Json,
  stopFilter?: string,
): FormationResult | null {
  const stops = asArray(data.formationsAtScheduledStops);
  const formations = asArray(data.formations);
  const vehicles = asArray(formations[0]?.formationVehicles);
  if (stops.length === 0 && vehicles.length === 0) return null;

  const stopNames: string[] = stops.map((s) => String(s.scheduledStop?.stopPoint?.name ?? '?'));

  // Halt wählen: Filter-Substring oder erster Halt.
  let stopIdx = 0;
  if (stopFilter) {
    const needle = stopFilter.trim().toLowerCase();
    const i = stopNames.findIndex((n) => n.toLowerCase().includes(needle));
    if (i >= 0) stopIdx = i;
  }
  const chosenStop = stops[stopIdx]?.scheduledStop;
  const chosenName = stopNames[stopIdx] ?? null;

  const cars: Car[] = vehicles.slice(0, 24).map((v: Json) => {
    const p: Json = v.vehicleProperties ?? {};
    const atStops = asArray(v.formationVehicleAtScheduledStops);
    // Sektor am gewählten Halt (Reihenfolge entspricht den Halten des Laufs).
    const atChosen =
      atStops[stopIdx] ??
      atStops.find((a: Json) => String(a.stopPoint?.name ?? '') === chosenName);
    return {
      // Manche EVUs (z.B. ZB) führen keine Kunden-Wagennummern → number ist 0.
      wagen: v.number != null && Number(v.number) > 0 ? Number(v.number) : null,
      position: v.position != null ? Number(v.position) : null,
      klasse: carClass(p),
      sektor: atChosen?.sectors != null ? String(atChosen.sectors) : null,
      ausstattung: carAmenities(p),
    };
  });

  return {
    evu,
    trainNumber,
    date,
    sektorenAmHalt: chosenName
      ? { name: chosenName, gleis: chosenStop?.track != null ? String(chosenStop.track) : null }
      : null,
    ...(formations.length > 1
      ? { hinweis: 'Die Formation ändert sich unterwegs (z.B. Flügelzug/Stärkung) — Sektorangaben gelten für den genannten Halt.' }
      : {}),
    wagen: cars,
    alleHalte: stopNames.slice(0, 20),
  };
}
