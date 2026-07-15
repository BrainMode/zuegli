// Wandelt die (grossen, verschachtelten) OJP-Antworten in kompakte,
// LLM-freundliche Objekte um. Ziele:
//  - Zeiten als "HH:mm" (Europe/Zurich) statt ISO+Offset → weniger Tokens,
//    und das Modell rechnet Verspätungen nicht selbst falsch aus.
//  - Verspätung explizit als delayMin (Minuten, aus Soll/Ist-Zeitpaar).
//  - Nur Felder, die der Chatbot für eine Antwort braucht.

import { arr, txt } from './client';

const TZ = 'Europe/Zurich';

// Interpretiert einen (evtl. offset-losen) ISO-Zeitstring als Europe/Zurich —
// UNABHÄNGIG von der Server-Zeitzone. Das Modell liefert Zeiten wie
// "2026-07-14T11:53:00" ohne Offset; new Date() würde das in der Server-TZ
// lesen. Auf Vercel läuft Node in UTC → „11:53" läge sonst 1–2 h daneben
// (DST-korrekt gelöst über den sv-SE-Trick).
export function parseZurich(s: string): Date {
  if (/([+-]\d{2}:?\d{2}|Z)$/.test(s)) return new Date(s); // hat bereits einen Offset
  const asUtc = new Date(`${s}Z`);
  if (Number.isNaN(asUtc.getTime())) return new Date(s);
  const zurichWall = new Date(
    `${asUtc.toLocaleString('sv-SE', { timeZone: TZ }).replace(' ', 'T')}Z`,
  );
  const offsetMs = zurichWall.getTime() - asUtc.getTime();
  return new Date(asUtc.getTime() - offsetMs);
}

export function hhmm(iso: string | null | undefined): string | null {
  if (!iso) return null;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return null;
  return d.toLocaleTimeString('de-CH', { hour: '2-digit', minute: '2-digit', timeZone: TZ });
}

/** OJP liefert Soll/Ist als Zeitpaar statt Sekunden-Delay → Minuten (gerundet). */
export function delayMinFromTimes(
  timetabled: string | null | undefined,
  estimated: string | null | undefined,
): number | null {
  if (!timetabled || !estimated) return null;
  const t = new Date(timetabled).getTime();
  const e = new Date(estimated).getTime();
  if (Number.isNaN(t) || Number.isNaN(e)) return null;
  return Math.round((e - t) / 60_000);
}

// ── Locations ───────────────────────────────────────────────────────────────

type OjpPlaceResult = {
  Place?: {
    StopPlace?: { StopPlaceRef?: unknown; StopPlaceName?: unknown };
    Name?: unknown;
    GeoPosition?: { Longitude?: unknown; Latitude?: unknown };
    Mode?: unknown;
  };
  Probability?: unknown;
};

export type Station = {
  id: string;
  name: string;
  latitude: number | null;
  longitude: number | null;
  products: string[];
};

export function formatPlaceResult(p: OjpPlaceResult): Station {
  const place = p.Place ?? {};
  const stop = place.StopPlace ?? {};
  const geo = place.GeoPosition;
  return {
    id: txt(stop.StopPlaceRef) ?? '',
    name: txt(stop.StopPlaceName) ?? txt(place.Name) ?? '',
    latitude: geo?.Latitude != null ? Number(txt(geo.Latitude)) : null,
    longitude: geo?.Longitude != null ? Number(txt(geo.Longitude)) : null,
    products: arr(place.Mode)
      .map((m) => txt((m as { PtMode?: unknown }).PtMode))
      .filter((x): x is string => Boolean(x)),
  };
}

// ── Service (Zug/Linie) — gemeinsam für StopEvent, TripLeg, TripInfo ────────

type OjpService = {
  Mode?: { PtMode?: unknown };
  PublishedServiceName?: unknown;
  TrainNumber?: unknown;
  JourneyRef?: unknown;
  OperatingDayRef?: unknown;
  DestinationText?: unknown;
  OriginText?: unknown;
  Cancelled?: unknown;
  Attribute?: unknown;
};

/** tripId-Vertrag: OJP braucht JourneyRef + OperatingDayRef → ein String mit `~`. */
export function makeTripId(service: OjpService): string | null {
  const j = txt(service.JourneyRef);
  const d = txt(service.OperatingDayRef);
  return j && d ? `${j}~${d}` : null;
}

export function splitTripId(tripId: string): { journeyRef: string; operatingDayRef: string } | null {
  const i = tripId.lastIndexOf('~');
  if (i <= 0) return null;
  return { journeyRef: tripId.slice(0, i), operatingDayRef: tripId.slice(i + 1) };
}

/** Linienname inkl. Zugnummer (z.B. "IC 1" + Nr. 711 → für Formation/Belegung). */
export function serviceLine(service: OjpService): { line: string; trainNumber: string | null } {
  const name = txt(service.PublishedServiceName) ?? '?';
  const trainNumber = txt(service.TrainNumber);
  const mode = txt(service.Mode?.PtMode);
  // Bei Zügen ist der PublishedServiceName oft nur "IC 1"; die Zugnummer
  // separat mitgeben, damit trainFormation/getOccupancy sie nutzen können.
  return { line: mode === 'rail' && !/\d/.test(name) && trainNumber ? `${name} ${trainNumber}` : name, trainNumber };
}

/** Attribute/Hinweise eines Kurses (Velo, Restaurant, Niederflur …) als Texte. */
export function attributeTexts(service: OjpService, max = 4): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const a of arr(service.Attribute)) {
    const t = txt((a as { UserText?: unknown }).UserText) ?? txt(a);
    if (t && !seen.has(t)) {
      seen.add(t);
      out.push(t);
      if (out.length >= max) break;
    }
  }
  return out;
}

// ── StopEvents (Abfahrts-/Ankunftstafel) ────────────────────────────────────

type OjpCallAtStop = {
  StopPointRef?: unknown;
  StopPointName?: unknown;
  PlannedQuay?: unknown;
  EstimatedQuay?: unknown;
  ServiceArrival?: { TimetabledTime?: unknown; EstimatedTime?: unknown };
  ServiceDeparture?: { TimetabledTime?: unknown; EstimatedTime?: unknown };
  NotServicedStop?: unknown;
};

type OjpStopEvent = {
  ThisCall?: { CallAtStop?: OjpCallAtStop };
  Service?: OjpService;
};

export type BoardEntry = {
  line: string;
  trainNumber: string | null;
  direction?: string;
  origin?: string;
  plannedTime: string | null;
  time: string | null;
  delayMin: number | null;
  platform: string | null;
  platformChanged: boolean;
  cancelled: boolean;
  tripId: string | null;
};

/** Gemeinsame Formatierung für Abfahrten und Ankünfte. */
export function formatStopEvent(se: OjpStopEvent, kind: 'departure' | 'arrival'): BoardEntry {
  const call = se.ThisCall?.CallAtStop ?? {};
  const service = se.Service ?? {};
  const timePair = kind === 'departure' ? call.ServiceDeparture : call.ServiceArrival;
  const timetabled = txt(timePair?.TimetabledTime);
  const estimated = txt(timePair?.EstimatedTime);
  const planned = txt(call.PlannedQuay);
  const estQuay = txt(call.EstimatedQuay);
  const { line, trainNumber } = serviceLine(service);
  return {
    line,
    trainNumber,
    ...(kind === 'departure'
      ? { direction: txt(service.DestinationText) ?? '?' }
      : { origin: txt(service.OriginText) ?? '?' }),
    plannedTime: hhmm(timetabled),
    time: hhmm(estimated ?? timetabled),
    delayMin: delayMinFromTimes(timetabled, estimated),
    platform: estQuay ?? planned ?? null,
    platformChanged: planned != null && estQuay != null && planned !== estQuay,
    cancelled: String(service.Cancelled) === 'true',
    tripId: makeTripId(service),
  };
}

// ── Trips (Verbindungssuche) ────────────────────────────────────────────────

type OjpLegPoint = OjpCallAtStop & { Order?: unknown };

type OjpTimedLeg = {
  LegBoard?: OjpLegPoint;
  LegAlight?: OjpLegPoint;
  Service?: OjpService;
};

type OjpLeg = { Id?: unknown; TimedLeg?: OjpTimedLeg; TransferLeg?: unknown; ContinuousLeg?: unknown };

export type OjpTrip = {
  Id?: unknown;
  Duration?: unknown;
  Transfers?: unknown;
  Leg?: OjpLeg | OjpLeg[];
};

export type JourneyLeg = {
  line: string;
  trainNumber: string | null;
  direction: string;
  from: string;
  fromPlatform: string | null;
  dep: string | null;
  depDelayMin: number | null;
  to: string;
  toPlatform: string | null;
  arr: string | null;
  arrDelayMin: number | null;
  cancelled: boolean;
  tripId: string | null;
  amenities: string[];
};

export function formatTrip(trip: OjpTrip): {
  departure: string | null;
  departureDelayMin: number | null;
  arrival: string | null;
  arrivalDelayMin: number | null;
  transfers: number;
  durationMin: number | null;
  legs: JourneyLeg[];
} {
  const timedLegs = arr(trip.Leg)
    .map((l) => l.TimedLeg)
    .filter((l): l is OjpTimedLeg => Boolean(l));

  const legs: JourneyLeg[] = timedLegs.map((l) => {
    const board = l.LegBoard ?? {};
    const alight = l.LegAlight ?? {};
    const service = l.Service ?? {};
    const depT = txt(board.ServiceDeparture?.TimetabledTime);
    const depE = txt(board.ServiceDeparture?.EstimatedTime);
    const arrT = txt(alight.ServiceArrival?.TimetabledTime);
    const arrE = txt(alight.ServiceArrival?.EstimatedTime);
    const { line, trainNumber } = serviceLine(service);
    return {
      line,
      trainNumber,
      direction: txt(service.DestinationText) ?? '?',
      from: txt(board.StopPointName) ?? '?',
      fromPlatform: txt(board.EstimatedQuay) ?? txt(board.PlannedQuay) ?? null,
      dep: hhmm(depE ?? depT),
      depDelayMin: delayMinFromTimes(depT, depE),
      to: txt(alight.StopPointName) ?? '?',
      toPlatform: txt(alight.EstimatedQuay) ?? txt(alight.PlannedQuay) ?? null,
      arr: hhmm(arrE ?? arrT),
      arrDelayMin: delayMinFromTimes(arrT, arrE),
      cancelled: String(service.Cancelled) === 'true',
      tripId: makeTripId(service),
      amenities: attributeTexts(service),
    };
  });

  const first = legs[0];
  const last = legs[legs.length - 1];
  return {
    departure: first?.dep ?? null,
    departureDelayMin: first?.depDelayMin ?? null,
    arrival: last?.arr ?? null,
    arrivalDelayMin: last?.arrDelayMin ?? null,
    transfers: Math.max(0, legs.length - 1),
    durationMin: isoDurationMin(txt(trip.Duration)),
    legs,
  };
}

/** "PT1H48M" → 108 Minuten. */
export function isoDurationMin(d: string | null): number | null {
  if (!d) return null;
  const m = /^PT(?:(\d+)H)?(?:(\d+)M)?/.exec(d);
  if (!m) return null;
  return Number(m[1] ?? 0) * 60 + Number(m[2] ?? 0);
}

// ── TripInfo (Zuglauf) ──────────────────────────────────────────────────────

export function formatCall(call: OjpCallAtStop): {
  name: string;
  arr: string | null;
  arrDelayMin: number | null;
  dep: string | null;
  depDelayMin: number | null;
  platform: string | null;
  cancelled: boolean;
} {
  const arrT = txt(call.ServiceArrival?.TimetabledTime);
  const arrE = txt(call.ServiceArrival?.EstimatedTime);
  const depT = txt(call.ServiceDeparture?.TimetabledTime);
  const depE = txt(call.ServiceDeparture?.EstimatedTime);
  return {
    name: txt(call.StopPointName) ?? '?',
    arr: hhmm(arrE ?? arrT),
    arrDelayMin: delayMinFromTimes(arrT, arrE),
    dep: hhmm(depE ?? depT),
    depDelayMin: delayMinFromTimes(depT, depE),
    platform: txt(call.EstimatedQuay) ?? txt(call.PlannedQuay) ?? null,
    cancelled: String(call.NotServicedStop) === 'true',
  };
}
