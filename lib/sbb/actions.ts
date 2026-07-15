// Die 10 Kern-Funktionen der Schweizer Bahn-Auskunft. Reine Funktionen ohne
// Framework-Bezug — werden identisch vom Chat-Agent (lib/tools.ts) UND vom
// MCP-Server (app/api/[transport]/route.ts) genutzt. Keine Logik-Duplikation.
//
// Jede Funktion fängt API-Fehler ab und gibt im Fehlerfall { error } zurück,
// damit ein API-Ausfall nicht den Antwort-Stream crasht — das Modell kann die
// Fehlermeldung dem Nutzer erklären.

import { createHash } from 'node:crypto';
import { cached, cachePut, cacheGet } from '../cache';
import { ojpRequest, ojpRequestRaw, arr, txt, OjpError, QUOTA_ERROR, ojpParser } from './client';
import {
  locationInformationRequest,
  geoLocationRequest,
  stopEventRequest,
  tripRequest,
  tripInfoRequest,
  fareRequestEnvelope,
} from './requests';
import {
  formatPlaceResult,
  formatStopEvent,
  formatTrip,
  formatCall,
  serviceLine,
  attributeTexts,
  splitTripId,
  parseTimeInput,
  type Station,
  type OjpTrip,
} from './format';
import { formation } from './formation';
import { occupancyForecast } from './occupancy';
import { fetchAllSituations, type Situation } from './disruptions';

const API_ERROR = {
  error:
    'Die Open-Data-Schnittstelle (opentransportdata.swiss) antwortet gerade nicht. Bitte in einer Minute erneut versuchen.',
};

const NOT_CONFIGURED = {
  error: 'nicht_konfiguriert',
  hint:
    'Dafür fehlt noch der (kostenlose) API-Key von opentransportdata.swiss. Frag mich stattdessen etwas anderes rund um Züge in der Schweiz.',
};

function logError(fn: string, err: unknown) {
  const msg = err instanceof Error ? err.message : String(err);
  console.warn(`[sbb:${fn}]`, msg);
}

/** Einheitliches Fehler-Mapping: Quota/Key-Fälle klar benennen, Rest generisch. */
function toError(fn: string, err: unknown) {
  logError(fn, err);
  if (err instanceof OjpError) {
    if (err.code === 'quota') return QUOTA_ERROR;
    if (err.code === 'nicht_konfiguriert') return NOT_CONFIGURED;
    // Fachlich leere Antworten (NO_RESULTS o.ä.) sind kein Ausfall.
    if (err.code === 'ojp_status') return { error: `Keine Daten: ${err.message}` };
    if (err.code === 'keine_daten') return { error: 'keine_daten', hint: err.message };
    // 400 = die Datenquelle hat UNSERE Anfrage abgelehnt — kein Ausfall,
    // sondern (fast immer) unbrauchbare Parameter. Ehrlich sagen statt
    // „API antwortet nicht".
    if (err.code === 'http' && err.status === 400) {
      return {
        error: 'ungueltige_anfrage',
        hint: 'Die Datenquelle hat die Anfrage abgelehnt — Parameter prüfen (IDs aus searchStations verwenden, Zeiten im ISO-Format).',
      };
    }
  }
  return API_ERROR;
}

/** Klarer Hinweis bei unverständlicher Zeitangabe (statt irreführendem API-Fehler). */
function timeError(value: string) {
  return {
    error: 'zeitformat',
    hint: `Zeitangabe "${value}" nicht verstanden — bitte ISO-Format (YYYY-MM-DDTHH:mm) oder "HH:mm" verwenden.`,
  };
}

/** Normalisiert Betriebstage: "YYYY-MM-DD" oder "DD.MM.YYYY" → "YYYY-MM-DD", sonst null. */
function normalizeDay(s: string): string | null {
  const t = s.trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(t)) return t;
  const dm = /^(\d{1,2})\.(\d{1,2})\.(\d{4})$/.exec(t);
  if (dm) return `${dm[3]}-${dm[2].padStart(2, '0')}-${dm[1].padStart(2, '0')}`;
  return null;
}

// ── 1) Bahnhofssuche ────────────────────────────────────────────────────────

export type StationResult = { stations: Station[] } | { error: string };

/** Sucht Bahnhöfe/Haltestellen nach Name. Liefert IDs für alle anderen Tools. */
export async function searchStations(query: string): Promise<StationResult | { error: string; hint: string }> {
  const q = query.trim();
  if (!q) {
    return { error: 'leere_suche', hint: 'Bitte einen Bahnhofs- oder Ortsnamen angeben.' };
  }
  if (q.length > 120) {
    return { error: 'zu_lang', hint: 'Suchbegriff ist zu lang — bitte nur den Bahnhofs-/Ortsnamen angeben.' };
  }
  // Halt-IDs (SLOIDs) ändern sich praktisch nie → 24 h cachen.
  return cached(`stations:${q.toLowerCase()}`, 86_400, async () => {
    try {
      const delivery = await ojpRequest(
        locationInformationRequest(q, { results: 6 }),
        'OJPLocationInformationDelivery',
      );
      const places = arr((delivery as Record<string, unknown>).PlaceResult);
      return { stations: places.map((p) => formatPlaceResult(p as never)) };
    } catch (err) {
      return toError('searchStations', err);
    }
  });
}

// ── 2+3) Abfahrten / Ankünfte ───────────────────────────────────────────────

type BoardOpts = { when?: string; towards?: string; line?: string };

/** Normalisiert Linienbezeichnungen für den Vergleich: „IC 728" → „ic728". */
function normLine(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]/g, '');
}

async function stopEvents(
  kind: 'departure' | 'arrival',
  stationId: string,
  when: Date | undefined,
) {
  const delivery = await ojpRequest(
    stopEventRequest(stationId, { type: kind, when, results: 14 }),
    'OJPStopEventDelivery',
  );
  const results = arr((delivery as Record<string, any>).StopEventResult);
  return results.map((r) => formatStopEvent((r as Record<string, any>).StopEvent ?? r, kind));
}

const EMPTY_BOARD_HINT =
  'Keine Fahrten gefunden — stimmt die stationId (bitte die id aus searchStations verwenden)? Bei Zeitangaben: Liegt der Zeitpunkt evtl. in der Vergangenheit?';

/** Abfahrtstafel eines Bahnhofs. `towards` filtert nach Richtung, `line` nach Linie/Zugnummer. */
export async function getDepartures(stationId: string, opts: BoardOpts = {}) {
  let when: Date | undefined;
  if (opts.when) {
    const d = parseTimeInput(opts.when);
    if (!d) return timeError(opts.when);
    when = d;
  }
  const key = `dep:${stationId}:${opts.when ?? 'now'}:${opts.towards ?? ''}:${opts.line ?? ''}`;
  return cached(key, 30, async () => {
    try {
      let entries = await stopEvents('departure', stationId, when);
      if (opts.towards) {
        const needle = opts.towards.toLowerCase();
        const filtered = entries.filter((e) => e.direction?.toLowerCase().includes(needle));
        // Nur filtern, wenn dadurch nicht alles wegfällt (Richtung evtl. Zwischenziel).
        if (filtered.length > 0) entries = filtered;
      }
      if (opts.line) {
        // Deterministisch den gesuchten Zug herausfiltern (statt Modell-Raten).
        const q = normLine(opts.line);
        const matches = (e: { line: string; trainNumber: string | null }) =>
          [e.line, e.trainNumber ?? ''].map(normLine);
        const exact = entries.filter((e) => matches(e).some((m) => m === q));
        const partial = entries.filter((e) => matches(e).some((m) => m && (m.includes(q) || q.includes(m))));
        const filtered = exact.length > 0 ? exact : partial;
        if (filtered.length > 0) entries = filtered;
      }
      return {
        station: stationId,
        departures: entries.slice(0, 10),
        ...(entries.length === 0 ? { hint: EMPTY_BOARD_HINT } : {}),
      };
    } catch (err) {
      return toError('getDepartures', err);
    }
  });
}

/** Ankunftstafel eines Bahnhofs. */
export async function getArrivals(stationId: string, opts: BoardOpts = {}) {
  let when: Date | undefined;
  if (opts.when) {
    const d = parseTimeInput(opts.when);
    if (!d) return timeError(opts.when);
    when = d;
  }
  const key = `arr:${stationId}:${opts.when ?? 'now'}:${opts.towards ?? ''}`;
  return cached(key, 30, async () => {
    try {
      let entries = await stopEvents('arrival', stationId, when);
      if (opts.towards) {
        const needle = opts.towards.toLowerCase();
        const filtered = entries.filter((e) => e.origin?.toLowerCase().includes(needle));
        if (filtered.length > 0) entries = filtered;
      }
      return {
        station: stationId,
        arrivals: entries.slice(0, 10),
        ...(entries.length === 0 ? { hint: EMPTY_BOARD_HINT } : {}),
      };
    } catch (err) {
      return toError('getArrivals', err);
    }
  });
}

// ── 4) Verbindungssuche (inkl. fareRef für Preise) ──────────────────────────

type JourneyOpts = { departure?: string; arrival?: string };

/** Extrahiert die rohen <Trip>-Fragmente in Dokumentreihenfolge (für FareRequest). */
function rawTrips(rawXml: string): string[] {
  const out: string[] = [];
  const re = /<(?:\w+:)?Trip>([\s\S]*?)<\/(?:\w+:)?Trip>/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(rawXml)) !== null) out.push(m[1]);
  return out;
}

/** Verbindungssuche A→B mit Umstiegen. */
export async function planJourney(fromId: string, toId: string, opts: JourneyOpts = {}) {
  if (fromId.trim() === toId.trim()) {
    return { error: 'gleiche_station', hint: 'Start und Ziel sind derselbe Bahnhof.' };
  }
  let departure: Date | undefined;
  let arrival: Date | undefined;
  if (opts.departure) {
    const d = parseTimeInput(opts.departure);
    if (!d) return timeError(opts.departure);
    departure = d;
  } else if (opts.arrival) {
    const d = parseTimeInput(opts.arrival);
    if (!d) return timeError(opts.arrival);
    arrival = d;
  }
  const key = `journey:${fromId}:${toId}:${opts.departure ?? ''}:${opts.arrival ?? 'now'}`;
  // Konkrete Zeit/Datum → 5 Min cachen; "jetzt" → 45 s.
  const ttl = opts.departure || opts.arrival ? 300 : 45;
  return cached(key, ttl, async () => {
    try {
      const { delivery, raw } = await ojpRequestRaw(
        tripRequest(fromId, toId, { departure, arrival, results: 3 }),
        'OJPTripDelivery',
      );
      const results = arr((delivery as Record<string, any>).TripResult);
      const rawXmlTrips = rawTrips(raw);

      const journeys = await Promise.all(
        results.map(async (r, i) => {
          const trip = (r as Record<string, unknown>).Trip as OjpTrip | undefined;
          const j = formatTrip(trip ?? {});
          // Roh-Trip fürs (Beta-)Fare-Tool 15 Min vorhalten → fareRef.
          let fareRef: string | null = null;
          const rawTrip = rawXmlTrips[i];
          if (rawTrip) {
            fareRef = createHash('sha1').update(rawTrip).digest('hex').slice(0, 12);
            await cachePut(`tripxml:${fareRef}`, 900, rawTrip);
          }
          return { ...j, fareRef };
        }),
      );
      return {
        journeys,
        ...(journeys.length === 0
          ? { hint: 'Keine Verbindung gefunden — stimmen die Bahnhofs-IDs (beide aus searchStations)?' }
          : {}),
      };
    } catch (err) {
      return toError('planJourney', err);
    }
  });
}

// ── 5) Zugverfolgung („Wo bleibt mein Zug?") ────────────────────────────────

/** Live-Fahrtverlauf eines konkreten Zuges. tripId = "journeyRef~operatingDayRef". */
export async function trackTrain(tripId: string) {
  // Live-Daten, aber 20 s Cache fängt Mehrfachanfragen ohne spürbaren Frischeverlust.
  return cached(`trip:${tripId}`, 20, async () => {
    try {
      const parts = splitTripId(tripId);
      if (!parts) {
        return {
          error:
            'Ungültige tripId — nutze die tripId aus getDepartures oder planJourney (Format journeyRef~datum).',
        };
      }
      const delivery = await ojpRequest(
        tripInfoRequest(parts.journeyRef, parts.operatingDayRef),
        'OJPTripInfoDelivery',
      );
      const result = (delivery as Record<string, any>).TripInfoResult ?? {};
      const service = result.Service ?? {};
      const calls = [...arr(result.PreviousCall), ...arr(result.OnwardCall)];
      if (calls.length === 0) {
        return {
          error: 'nicht_gefunden',
          hint: 'Dieser Zuglauf wurde nicht gefunden — die tripId ist vermutlich abgelaufen oder ungültig. Hole eine frische tripId über getDepartures oder planJourney.',
        };
      }
      const { line, trainNumber } = serviceLine(service);
      return {
        line,
        trainNumber,
        direction: txt(service.DestinationText) ?? '?',
        cancelled: String(service.Cancelled) === 'true',
        amenities: attributeTexts(service),
        stops: calls.map((c) => formatCall((c as Record<string, any>).CallAtStop ?? c)),
      };
    } catch (err) {
      return toError('trackTrain', err);
    }
  });
}

// ── 6) Umkreissuche ─────────────────────────────────────────────────────────

/** Findet Bahnhöfe/Haltestellen im Umkreis eines Ortes/einer Adresse. */
export async function nearbyStations(place: string) {
  const p = place.trim();
  if (!p) {
    return { error: 'leere_suche', hint: 'Bitte einen Ort oder eine Adresse angeben.' };
  }
  return cached(`nearby:${p.toLowerCase()}`, 86_400, async () => {
    try {
      // 1) Ort/Adresse geocoden (LIR ohne stop-Restriktion liefert auch Orte/POIs).
      const geoDelivery = await ojpRequest(
        locationInformationRequest(p, { restrictToStops: false, results: 1 }),
        'OJPLocationInformationDelivery',
      );
      const first = arr((geoDelivery as Record<string, any>).PlaceResult)[0];
      const pos = (first as Record<string, any>)?.Place?.GeoPosition;
      const lat = pos ? Number(txt(pos.Latitude)) : NaN;
      const lon = pos ? Number(txt(pos.Longitude)) : NaN;
      if (!Number.isFinite(lat) || !Number.isFinite(lon)) {
        return { stations: [], hint: `Kein Ort namens "${place}" gefunden.` };
      }
      // 2) Haltestellen im Umkreis (3 km).
      const delivery = await ojpRequest(
        geoLocationRequest(lat, lon, 3000, 6),
        'OJPLocationInformationDelivery',
      );
      const places = arr((delivery as Record<string, any>).PlaceResult);
      return { stations: places.map((p) => formatPlaceResult(p as never)) };
    } catch (err) {
      return toError('nearbyStations', err);
    }
  });
}

// ── 7) Wagenreihung / Formation (Schweiz-Exklusiv) ──────────────────────────

function todayZurich(): string {
  return new Date().toLocaleDateString('sv-SE', { timeZone: 'Europe/Zurich' });
}

const DAY_MS = 86_400_000;

/** Wagenreihung inkl. Perronsektoren. date = YYYY-MM-DD (Default: heute); stop wählt den Halt für die Sektorangaben. */
export async function trainFormation(trainNumber: string, date?: string, evu?: string, stop?: string) {
  const d = date ? normalizeDay(date) : todayZurich();
  if (!d) {
    return { error: 'datum', hint: `Datum "${date}" nicht verstanden — bitte YYYY-MM-DD.` };
  }
  // Gültigkeitsfenster der Formationsdaten VOR dem API-Call prüfen (spart Quota).
  const today = todayZurich();
  const diffDays = Math.round((new Date(`${d}T12:00Z`).getTime() - new Date(`${today}T12:00Z`).getTime()) / DAY_MS);
  if (diffDays < 0) {
    return { error: 'datum', hint: 'Formationsdaten gibt es nicht für vergangene Tage.' };
  }
  if (diffDays > 3) {
    return { error: 'datum', hint: 'Formationsdaten gibt es höchstens 3 Tage im Voraus.' };
  }
  const key = `formation:${trainNumber}:${d}:${evu ?? 'auto'}:${stop?.trim().toLowerCase() ?? ''}`;
  return cached(key, 120, async () => {
    try {
      return await formation(trainNumber, d, evu, stop);
    } catch (err) {
      return toError('trainFormation', err);
    }
  });
}

// ── 8) Belegungsprognose (Schweiz-Exklusiv) ─────────────────────────────────

/** Belegungsprognose je Klasse und Abschnitt. date = YYYY-MM-DD (Default: heute). */
export async function getOccupancy(trainNumber: string, date?: string) {
  const d = date ? normalizeDay(date) : todayZurich();
  if (!d) {
    return { error: 'datum', hint: `Datum "${date}" nicht verstanden — bitte YYYY-MM-DD.` };
  }
  // Der Datenimport lädt nur heute+morgen — für andere Tage ehrlich absagen,
  // statt fälschlich "Import noch nicht gelaufen" zu melden.
  const today = todayZurich();
  const tomorrow = new Date(Date.now() + DAY_MS).toLocaleDateString('sv-SE', { timeZone: 'Europe/Zurich' });
  if (d !== today && d !== tomorrow) {
    return {
      error: 'datum',
      hint: `Belegungsprognosen gibt es nur für heute (${today}) und morgen (${tomorrow}).`,
    };
  }
  return cached(`occupancy:${trainNumber}:${d}`, 300, async () => {
    try {
      return await occupancyForecast(trainNumber, d);
    } catch (err) {
      return toError('getOccupancy', err);
    }
  });
}

// ── 9) Störungen (SIRI-SX) ──────────────────────────────────────────────────

function matchesFilter(s: Situation, needle: string): boolean {
  const hay = [
    s.summary,
    s.description ?? '',
    ...s.affectedLines,
    ...s.affectedStops,
  ]
    .join(' ')
    .toLowerCase();
  return hay.includes(needle);
}

/** Aktuelle Störungen, optional gefiltert nach Strecke/Bahnhof/Linie/Stichwort. */
export async function getDisruptions(filter?: string) {
  try {
    const all = await fetchAllSituations();
    const needle = filter?.trim().toLowerCase();
    const hits = needle ? all.filter((s) => matchesFilter(s, needle)) : all;
    return {
      total: all.length,
      matching: hits.length,
      situations: hits.slice(0, 8),
      ...(needle && hits.length === 0
        ? { hint: `Keine aktuelle Störung zu "${filter}" im landesweiten Feed.` }
        : {}),
    };
  } catch (err) {
    return toError('getDisruptions', err);
  }
}

// ── 10) Preise (OJP Fare, BETA) ─────────────────────────────────────────────

/** Preisauskunft für eine Verbindung aus planJourney (via fareRef). */
export async function getFares(fareRef: string) {
  const endpoint = process.env.OTD_FARE_ENDPOINT;
  if (!endpoint) {
    return {
      error: 'nicht_konfiguriert',
      hint:
        'Die Preisauskunft (OJP Fare, Beta) ist noch nicht aktiviert. Preise gibt es derzeit auf sbb.ch.',
    };
  }
  return cached(`fares:${fareRef}`, 3600, async () => {
    try {
      const tripXml = await cacheGet<string>(`tripxml:${fareRef}`);
      if (!tripXml) {
        return {
          error: 'abgelaufen',
          hint: 'Diese Verbindung ist nicht mehr im Zwischenspeicher — bitte planJourney erneut aufrufen und die neue fareRef nutzen.',
        };
      }
      const res = await fetch(endpoint, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/xml',
          Authorization: `Bearer ${process.env.OTD_FARE_KEY ?? process.env.OTD_API_KEY}`,
        },
        body: fareRequestEnvelope(tripXml),
        signal: AbortSignal.timeout(15_000),
      });
      if (!res.ok) throw new OjpError(`Fare HTTP ${res.status}`, 'http', res.status);
      const doc = ojpParser.parse(await res.text()) as Record<string, any>;
      const fareDelivery = doc?.OJP?.OJPResponse?.ServiceDelivery?.OJPFareDelivery;
      const products = arr(fareDelivery?.FareResult)
        .flatMap((fr) => arr((fr as Record<string, any>).TripFareResult))
        .flatMap((tfr) => arr((tfr as Record<string, any>).FareProduct))
        .map((p) => {
          const prod = p as Record<string, any>;
          return {
            name: txt(prod.FareProductName),
            price: txt(prod.Price),
            currency: txt(prod.Currency) ?? 'CHF',
            travelClass: txt(prod.TravelClass),
          };
        })
        .filter((p) => p.price != null);
      if (products.length === 0) {
        return { error: 'kein_preis', hint: 'Für diese Verbindung liefert der (Beta-)Preisdienst keinen Preis.' };
      }
      return { products, note: 'Normalpreis ohne Halbtax/GA (Beta-Dienst, Angaben ohne Gewähr).' };
    } catch (err) {
      return toError('getFares', err);
    }
  });
}
