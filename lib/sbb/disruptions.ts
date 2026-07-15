// SIRI-SX-Störungsfeed (VDV 736, CH-Profil). Der Feed liefert ALLE Störungen
// der Schweiz als ein XML — wir holen ihn deshalb maximal 1× pro 60 s (geteilt
// über alle Nutzer via Redis + Request-Coalescing in cache.ts), kompaktieren
// sofort und filtern in-process. Roh-XML wird NIE gespeichert.
//
// Rate-Limits des Feeds sind niedrig (Cookbook: Voll-Feed ~48/Tag; der
// unplanned-Feed ist zum Polling gedacht) — der 60s-Shared-Cache hält uns
// weit darunter.

import { cached, cachePut, cacheGet } from '../cache';
import { otdGet, ojpParser, arr, txt, OjpError } from './client';

const SIRI_SX_URL =
  process.env.OTD_SIRI_SX_URL ?? 'https://api.opentransportdata.swiss/la/siri-sx-unplanned';

export type Situation = {
  id: string;
  severity: string | null;
  summary: string;
  description: string | null;
  validFrom: string | null;
  validTo: string | null;
  affectedLines: string[];
  affectedStops: string[];
};

/** Wählt aus mehrsprachigen Text-Knoten (xml:lang) bevorzugt Deutsch. */
function pickLang(nodes: unknown, lang = 'de'): string | null {
  const list = arr(nodes);
  if (list.length === 0) return null;
  for (const n of list) {
    const o = n as Record<string, unknown>;
    if (o && typeof o === 'object' && o['@xml:lang'] === lang) return txt(n);
  }
  return txt(list[0]);
}

type Pt = Record<string, any>;

function compact(pt: Pt): Situation | null {
  const summary = pickLang(pt.Summary);
  if (!summary) return null;
  const validity = arr(pt.ValidityPeriod)[0] as Pt | undefined;

  // CH-Profil: PublishingAction ist die massgebliche Affects-Quelle (die
  // Top-Level-Affects sind im CH-Profil deprecated).
  const lines = new Set<string>();
  const stops = new Set<string>();
  for (const action of arr(pt.PublishingActions?.PublishingAction)) {
    const affects = (action as Pt).PublishAtScope?.Affects ?? (action as Pt).Affects;
    if (!affects) continue;
    for (const net of arr(affects.Networks?.AffectedNetwork)) {
      for (const line of arr((net as Pt).AffectedLine)) {
        const name = txt((line as Pt).PublishedLineName) ?? txt((line as Pt).LineRef);
        if (name) lines.add(name);
      }
    }
    for (const sp of arr(affects.StopPoints?.AffectedStopPoint)) {
      const name = txt((sp as Pt).StopPointName) ?? txt((sp as Pt).StopPointRef);
      if (name) stops.add(name);
    }
  }

  return {
    id: txt(pt.SituationNumber) ?? '',
    severity: txt(pt.Severity),
    summary,
    description: pickLang(pt.Description)?.slice(0, 400) ?? null,
    validFrom: txt(validity?.StartTime),
    validTo: txt(validity?.EndTime),
    affectedLines: [...lines].slice(0, 8),
    affectedStops: [...stops].slice(0, 12),
  };
}

async function fetchAndCompact(): Promise<Situation[]> {
  const res = await otdGet(SIRI_SX_URL, {
    key: process.env.OTD_SIRI_SX_KEY ?? process.env.OTD_API_KEY,
    accept: 'application/xml',
  });
  const xml = await res.text();
  const doc = ojpParser.parse(xml) as Pt;
  const situations =
    doc?.Siri?.ServiceDelivery?.SituationExchangeDelivery?.Situations?.PtSituationElement;
  const out: Situation[] = [];
  for (const pt of arr(situations)) {
    // Geschlossene Situationen nicht mitschleppen.
    if (txt((pt as Pt).Progress) === 'closed') continue;
    const s = compact(pt as Pt);
    if (s) out.push(s);
  }
  return out;
}

/**
 * Alle aktuellen Störungen, kompaktiert. Maximal 1 Upstream-Fetch pro 60 s
 * (geteilt), mit 10-Minuten-Stale-Fallback, falls der Feed gerade klemmt.
 */
export async function fetchAllSituations(): Promise<Situation[]> {
  return cached('sirisx:all', 60, async () => {
    try {
      const fresh = await fetchAndCompact();
      // Stale-Kopie für den Fehlerfall aktualisieren (best effort, 10 min).
      void cachePut('sirisx:stale', 600, fresh);
      return fresh;
    } catch (err) {
      if (err instanceof OjpError && err.code === 'nicht_konfiguriert') throw err;
      // Feed klemmt → letzte bekannte Lage liefern, wenn vorhanden.
      const stale = await cacheGet<Situation[]>('sirisx:stale');
      if (Array.isArray(stale)) return stale;
      throw err;
    }
  });
}
