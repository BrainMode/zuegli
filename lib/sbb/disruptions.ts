// SIRI-SX-Störungslage (VDV 736, CH-Profil).
//
// Realität des abonnierten API-Produkts (per Smoke-Test verifiziert):
//  - Nur der VOLL-Feed /la/siri-sx ist freigeschaltet (der unplanned-Feed 403t).
//  - MAXIMAL 48 ABFRAGEN PRO TAG.
//  - Antwort ist ein Redirect auf eine signierte URL mit ~4.5 MB gzip
//    (~106 MB XML, ~1500 Situationen) — viel zu schwer für den Request-Pfad.
//
// Architektur deshalb wie bei der Belegung: ein Cron (/api/cron/disruptions,
// alle 30 Min = 48/Tag) lädt den Feed, kompaktiert sofort pro Situation
// (Chunk-Parsing statt 106-MB-Objektbaum) und legt EINEN gzip/base64-Blob in
// den Cache. getDisruptions liest nur noch den Blob. Ein harter Tageszähler
// (Puffer unter 48) schützt zusätzlich vor Smoke-Tests/Restarts.

import { Redis } from '@upstash/redis';
import { gzipSync, gunzipSync, strFromU8, strToU8 } from 'fflate';
import { cachePut, cacheGet } from '../cache';
import { ojpParser, arr, txt, OjpError } from './client';

const SIRI_SX_URL =
  process.env.OTD_SIRI_SX_URL ?? 'https://api.opentransportdata.swiss/la/siri-sx';
const SSXU_URL =
  process.env.OTD_SSXU_URL ?? 'https://api.opentransportdata.swiss/la/siri-sx-unplanned';

const DAILY_FETCH_CAP = 44; // Puffer unter dem 48/Tag-Limit des Voll-Feed-Abos
const SSXU_DAILY_CAP = 2500; // Puffer unter 3000/Tag des Unplanned-Abos
const BLOB_KEY = 'sirisx:blob';
const STALE_KEY = 'sirisx:stale';
const SSXU_BLOB_KEY = 'sirisxu:blob';
const SSXU_STALE_KEY = 'sirisxu:stale';

const hasUpstash = Boolean(
  process.env.UPSTASH_REDIS_REST_URL && process.env.UPSTASH_REDIS_REST_TOKEN,
);
const redis = hasUpstash ? Redis.fromEnv() : null;

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

// ── Cron-Seite: Feed laden, kompaktieren, Blob schreiben ────────────────────

/** Harter Tageszähler je Feed. true = Fetch erlaubt. */
async function underDailyCap(counter: string, cap: number): Promise<boolean> {
  if (!redis) return true; // lokal/Fork ohne Redis: Cron-Kadenz allein schützt
  try {
    const key = `zuegli:${counter}:fetches:${new Date().toISOString().slice(0, 10)}`;
    const used = await redis.incr(key);
    if (used === 1) await redis.expire(key, 90_000);
    return used <= cap;
  } catch {
    return true;
  }
}

/** Holt einen SIRI-Feed (folgt Redirects auf signierte URLs) und entpackt gzip. */
async function fetchFeedXml(url: string, key: string | undefined): Promise<string> {
  if (!key) throw new OjpError('SIRI-SX-Key fehlt', 'nicht_konfiguriert');
  const res = await fetch(url, {
    headers: {
      Authorization: `Bearer ${key}`,
      'User-Agent': 'zuegli (open-source; github.com/BrainMode/zuegli)',
    },
    signal: AbortSignal.timeout(120_000),
    // Redirect auf largeapi.… ist signiert; fetch folgt automatisch und lässt
    // den Authorization-Header cross-origin korrekt weg.
  });
  if (!res.ok) throw new OjpError(`SIRI-SX HTTP ${res.status}`, 'http', res.status);
  const bytes = new Uint8Array(await res.arrayBuffer());
  // Feed kommt ggf. als gzip-DATEI (ohne Content-Encoding) → Magic-Bytes prüfen.
  const xmlBytes = bytes[0] === 0x1f && bytes[1] === 0x8b ? gunzipSync(bytes) : bytes;
  return strFromU8(xmlBytes);
}

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

/**
 * Kompaktiert das (grosse) Feed-XML Situation für Situation — Chunk-Parsing
 * hält den Speicher klein statt einen 106-MB-Objektbaum zu bauen.
 */
function compactFeed(xml: string): Situation[] {
  const out: Situation[] = [];
  const re = /<PtSituationElement>[\s\S]*?<\/PtSituationElement>/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(xml)) !== null) {
    try {
      const doc = ojpParser.parse(m[0]) as Pt;
      const pt = doc?.PtSituationElement;
      if (!pt || txt(pt.Progress) === 'closed') continue;
      const s = compact(pt);
      if (s) out.push(s);
    } catch {
      // einzelne kaputte Situation überspringen
    }
  }
  return out;
}

/**
 * Lädt den SIRI-SX-VOLL-Feed (geplante + ungeplante Situationen, ~106 MB XML,
 * Abo-Limit 48/Tag) und schreibt die kompakte Lage als Blob. Läuft nur noch
 * 1×/Tag — die Frische kommt vom Unplanned-Feed (refreshUnplanned).
 */
export async function refreshDisruptions(): Promise<{ situations: number; blobKB: number }> {
  if (!(await underDailyCap('sirisx', DAILY_FETCH_CAP))) {
    throw new OjpError('SIRI-SX-Tageskontingent (48/Tag) erschöpft — Fetch übersprungen', 'quota');
  }
  const xml = await fetchFeedXml(SIRI_SX_URL, process.env.OTD_SIRI_SX_KEY ?? process.env.OTD_API_KEY);
  const situations = compactFeed(xml);
  const blob = Buffer.from(gzipSync(strToU8(JSON.stringify(situations)), { level: 6 })).toString(
    'base64',
  );
  await cachePut(BLOB_KEY, 26 * 3600, blob); // 26 h: überlebt einen verpassten Tages-Cron
  await cachePut(STALE_KEY, 48 * 3600, blob);
  return { situations: situations.length, blobKB: Math.round(blob.length / 1024) };
}

/**
 * Lädt den kleinen UNPLANNED-Feed (~0.5 MB, Abo 3000/Tag, 2/min) — läuft alle
 * 2 Minuten und macht die Akut-Störungslage fast live.
 */
export async function refreshUnplanned(): Promise<{ situations: number; blobKB: number }> {
  if (!(await underDailyCap('sirisxu', SSXU_DAILY_CAP))) {
    throw new OjpError('SSXU-Tageskontingent erschöpft — Fetch übersprungen', 'quota');
  }
  const xml = await fetchFeedXml(SSXU_URL, process.env.OTD_SSXU_KEY ?? process.env.OTD_API_KEY);
  const situations = compactFeed(xml);
  const blob = Buffer.from(gzipSync(strToU8(JSON.stringify(situations)), { level: 6 })).toString(
    'base64',
  );
  await cachePut(SSXU_BLOB_KEY, 10 * 60, blob);
  await cachePut(SSXU_STALE_KEY, 6 * 3600, blob);
  return { situations: situations.length, blobKB: Math.round(blob.length / 1024) };
}

// ── Lese-Seite ──────────────────────────────────────────────────────────────

let memSituations: { exp: number; data: Situation[] } | null = null;

function decodeBlob(blob: string): Situation[] {
  return JSON.parse(strFromU8(gunzipSync(Buffer.from(blob, 'base64')))) as Situation[];
}

/**
 * Aktuelle Störungslage: geplante Situationen aus dem täglichen Voll-Feed,
 * gemergt mit dem 2-Minuten-Unplanned-Feed (gewinnt bei gleicher
 * SituationNumber). In-Memory 90 s pro Instanz.
 * Wirft OjpError('keine_daten'), wenn noch kein Import gelaufen ist.
 */
export async function fetchAllSituations(): Promise<Situation[]> {
  if (memSituations && memSituations.exp > Date.now()) return memSituations.data;

  const fullBlob = (await cacheGet<string>(BLOB_KEY)) ?? (await cacheGet<string>(STALE_KEY));
  const unplannedBlob =
    (await cacheGet<string>(SSXU_BLOB_KEY)) ?? (await cacheGet<string>(SSXU_STALE_KEY));
  if (!fullBlob && !unplannedBlob) {
    throw new OjpError(
      'Die Störungslage ist noch nicht importiert (Datenimport noch nicht gelaufen oder Redis fehlt).',
      'keine_daten',
    );
  }
  const merged = new Map<string, Situation>();
  if (fullBlob) for (const s of decodeBlob(fullBlob)) merged.set(s.id || s.summary, s);
  if (unplannedBlob) for (const s of decodeBlob(unplannedBlob)) merged.set(s.id || s.summary, s);
  const data = [...merged.values()];
  memSituations = { exp: Date.now() + 90_000, data };
  return data;
}
