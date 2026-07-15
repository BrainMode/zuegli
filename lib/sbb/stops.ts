// Haltestellen-Stammdaten (ATLAS Service Points) — die Koordinatenquelle für
// die Live-Karte. Der SIRI-ET-Feed referenziert Halte nur per StopPointRef
// (ch:1:sloid:N bzw. ch:1:ScheduledStopPoint:BPUIC), OHNE Koordinaten.
//
// Quelle: tägliches CSV-ZIP (~4 MB) via Dataset-Seite (CKAN-API ist geblockt →
// HTML-Scrape wie occupancy.ts). Verifiziert (Smoke): Semikolon-CSV mit BOM,
// 59k Zeilen, Spalten u.a. sloid, number (volle BPUIC inkl. Ländercode),
// designationOfficial, stopPoint, wgs84East (lon), wgs84North (lat).
//
// Index als gzip/base64-Chunks in Redis (Upstash-Limit 1 MB/Command), TTL 8 d
// (ein verpasster Tages-Cron blankt die Karte nie).

import { gzipSync, gunzipSync, unzipSync, strFromU8, strToU8 } from 'fflate';
import { cachePut, cacheGet } from '../cache';

const DATASET_PAGES = [
  process.env.OTD_STOPS_DATASET_URL,
  'https://data.opentransportdata.swiss/dataset/service-points-actual-date',
  'https://data.opentransportdata.swiss/dataset/service-point-v2',
].filter(Boolean) as string[];

const CHUNK_LIMIT = 900 * 1024; // base64-Zeichen je Redis-Wert
const TTL_SEC = 8 * 86_400;

export type StopIndex = {
  sloid: Record<string, [number, number]>; // numerischer sloid-Tail → [lon, lat]
  uic: Record<string, [number, number]>; // volle BPUIC → [lon, lat]
};

async function fetchBytes(url: string): Promise<Uint8Array> {
  const res = await fetch(url, {
    headers: { 'User-Agent': 'Mozilla/5.0 zuegli (open-source)' },
    signal: AbortSignal.timeout(60_000),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status} für ${url}`);
  return new Uint8Array(await res.arrayBuffer());
}

async function findCsvUrl(): Promise<string> {
  for (const page of DATASET_PAGES) {
    try {
      const html = strFromU8(await fetchBytes(page));
      const m =
        /href="(https:\/\/data\.opentransportdata\.swiss\/[^"]*\/download\/[^"]*\.csv[^"]*)"/i.exec(html);
      if (m) return m[1];
    } catch {
      // nächste Seite probieren
    }
  }
  throw new Error('Keine Service-Points-CSV-URL gefunden (Dataset-Seiten geändert?)');
}

/** ZIP/gzip/plain tolerant → CSV-Text. */
function toCsvText(bytes: Uint8Array): string {
  if (bytes[0] === 0x50 && bytes[1] === 0x4b) {
    const files = unzipSync(bytes);
    const name = Object.keys(files).find((n) => n.endsWith('.csv')) ?? Object.keys(files)[0];
    if (!name) throw new Error('ZIP ohne CSV');
    return strFromU8(files[name]);
  }
  if (bytes[0] === 0x1f && bytes[1] === 0x8b) return strFromU8(gunzipSync(bytes));
  return strFromU8(bytes);
}

function round5(n: number): number {
  return Math.round(n * 1e5) / 1e5;
}

function buildIndex(csv: string): { index: StopIndex; rows: number; kept: number } {
  const lines = csv.split('\n');
  const headerLine = (lines[0] ?? '').replace(/^﻿/, '');
  const delim = headerLine.includes(';') ? ';' : ',';
  const header = headerLine.split(delim).map((h) => h.trim().replace(/^"|"$/g, ''));
  const col = (name: string) => header.findIndex((h) => h.toLowerCase() === name.toLowerCase());
  const iSloid = col('sloid');
  const iNumber = col('number');
  const iEast = col('wgs84East');
  const iNorth = col('wgs84North');
  const iStop = col('stopPoint');
  if (iEast < 0 || iNorth < 0 || iSloid < 0) {
    throw new Error(`CSV-Header unerwartet: ${headerLine.slice(0, 200)}`);
  }

  const index: StopIndex = { sloid: {}, uic: {} };
  let kept = 0;
  for (let i = 1; i < lines.length; i++) {
    const cells = lines[i].split(delim);
    const lon = Number(cells[iEast]);
    const lat = Number(cells[iNorth]);
    if (!Number.isFinite(lon) || !Number.isFinite(lat) || lon === 0) continue;
    // Nur echte Haltepunkte (operating points ohne Halt braucht die Karte nicht) —
    // tolerant: fehlt die Spalte, alles behalten.
    if (iStop >= 0 && !/true|1|ja|yes/i.test(cells[iStop] ?? '')) continue;
    const pos: [number, number] = [round5(lon), round5(lat)];
    const sloid = (cells[iSloid] ?? '').trim();
    const tail = /^ch:1:sloid:(\d+)/.exec(sloid)?.[1];
    if (tail) index.sloid[tail] = pos;
    const num = (cells[iNumber] ?? '').trim().replace(/\D/g, '');
    if (num) index.uic[num] = pos;
    kept++;
  }
  return { index, rows: lines.length - 1, kept };
}

function encodeChunks(json: string): string[] {
  const b64 = Buffer.from(gzipSync(strToU8(json), { level: 6 })).toString('base64');
  const chunks: string[] = [];
  for (let i = 0; i < b64.length; i += CHUNK_LIMIT) chunks.push(b64.slice(i, i + CHUNK_LIMIT));
  return chunks;
}

/** Täglicher Import: CSV laden, Index bauen, als Chunks in den Cache. */
export async function refreshStops(): Promise<{
  rows: number;
  kept: number;
  chunks: number;
  blobKB: number;
}> {
  const url = await findCsvUrl();
  const csv = toCsvText(await fetchBytes(url));
  const { index, rows, kept } = buildIndex(csv);
  if (kept < 5000) throw new Error(`Nur ${kept} Halte behalten — CSV-Format prüfen (${url})`);

  const chunks = encodeChunks(JSON.stringify(index));
  for (let i = 0; i < chunks.length; i++) await cachePut(`stops:${i}`, TTL_SEC, chunks[i]);
  await cachePut(`stops:meta`, TTL_SEC, { chunks: chunks.length, updated: Date.now(), kept });
  return {
    rows,
    kept,
    chunks: chunks.length,
    blobKB: Math.round(chunks.reduce((s, c) => s + c.length, 0) / 1024),
  };
}

// In-Memory-Cache pro Instanz (6 h) — der Index ist einige MB gross und wird
// vom Livemap-Cron jede Minute gebraucht.
let memIndex: { exp: number; index: StopIndex | null } | null = null;

export async function loadStopIndex(): Promise<StopIndex | null> {
  if (memIndex && memIndex.exp > Date.now()) return memIndex.index;
  let index: StopIndex | null = null;
  try {
    const meta = await cacheGet<{ chunks: number }>(`stops:meta`);
    if (meta?.chunks) {
      const parts: string[] = [];
      for (let i = 0; i < meta.chunks; i++) {
        const c = await cacheGet<string>(`stops:${i}`);
        if (!c) throw new Error(`stops:${i} fehlt`);
        parts.push(c);
      }
      index = JSON.parse(strFromU8(gunzipSync(Buffer.from(parts.join(''), 'base64')))) as StopIndex;
    }
  } catch {
    index = null;
  }
  memIndex = { exp: Date.now() + 6 * 3600_000, index };
  return index;
}

/** Löst einen SIRI-StopPointRef gegen den Index auf. */
export function resolveStop(index: StopIndex, ref: string): [number, number] | null {
  const sloid = /^ch:1:sloid:(\d+)/.exec(ref)?.[1];
  if (sloid) return index.sloid[sloid] ?? index.uic[`85${sloid.padStart(5, '0')}`] ?? null;
  const digits = /(\d{6,})/.exec(ref)?.[1];
  if (digits) return index.uic[digits] ?? null;
  return null;
}
