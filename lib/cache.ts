// Leichtes Caching für ÖV-Antworten und Import-Blobs. Wichtigster Quota-Schutz:
// Fragen 500 Leute dasselbe, geht es nur EINMAL an die (auf 20k Requests/Tag
// limitierte) Open-Data-API. Fehlerergebnisse ({ error }) werden NIE gecacht.
//
// Speicher-Reihenfolge:
//  1. Upstash Redis — nur wenn konfiguriert UND erreichbar (lib/redis.ts).
//  2. Vercel Runtime Cache (getCache aus @vercel/functions) — regionaler
//     Key-Value-Speicher, geteilt zwischen allen Funktionen des Projekts in
//     derselben Region (hier fra1, siehe vercel.json). Damit sehen Chat und
//     MCP die Blobs der Import-Crons auch ohne Redis. Ausserhalb von Vercel
//     (npm run dev) fällt getCache automatisch auf einen In-Memory-Cache zurück.
// Ein gesperrtes Redis (Free-Tier-Limit) macht so nie mehr die App kaputt.

import { getCache } from '@vercel/functions';
import { redisTry } from './redis';

const runtime = getCache({ namespace: 'zuegli' });

function isError(v: unknown): boolean {
  return Boolean(v && typeof v === 'object' && 'error' in v);
}

const full = (key: string) => `zuegli:cache:${key}`;

/** Schreibt nach Redis; ist Redis nicht verfügbar, in den Runtime Cache. */
async function store(k: string, value: unknown, ttlSec: number): Promise<void> {
  const ok = await redisTry(`set ${k}`, (r) => r.set(k, value, { ex: ttlSec }));
  if (ok !== undefined) return;
  try {
    await runtime.set(k, value, { ttl: ttlSec });
  } catch {
    // best effort — der Runtime-Cache-Client loggt selbst
  }
}

/**
 * Liest aus Redis; ist Redis nicht verfügbar (undefined ≠ Miss), aus dem
 * Runtime Cache. Ein echter Redis-Miss (null) bleibt ein Miss.
 */
async function load<T>(k: string): Promise<T | undefined> {
  const hit = await redisTry(`get ${k}`, (r) => r.get<T>(k));
  if (hit !== undefined) return hit ?? undefined;
  try {
    const v = (await runtime.get(k)) as T | null;
    return v ?? undefined;
  } catch {
    return undefined;
  }
}

/** Direktes Schreiben (für Stale-Kopien u.ä. — im Gegensatz zu cached() wird IMMER überschrieben). */
export async function cachePut(key: string, ttlSec: number, value: unknown): Promise<void> {
  await store(full(key), value, ttlSec);
}

/** Direktes Lesen ohne Loader. undefined = kein Treffer. */
export async function cacheGet<T>(key: string): Promise<T | undefined> {
  return load<T>(full(key));
}

/**
 * Mehrere Keys auf einmal — mit Redis als EIN Befehl (MGET; die Live-Karte
 * fragt bis zu 40 Fahrweg-Segmente pro Request ab), sonst parallel aus dem
 * Runtime Cache. Ergebnis in Key-Reihenfolge, undefined = kein Treffer.
 */
export async function cacheGetMany<T>(keys: string[]): Promise<(T | undefined)[]> {
  if (keys.length === 0) return [];
  const ks = keys.map(full);
  const hits = await redisTry(`mget ×${ks.length}`, (r) => r.mget<(T | null)[]>(...ks));
  if (hits !== undefined) return hits.map((h) => h ?? undefined);
  return Promise.all(
    ks.map(async (k) => {
      try {
        return ((await runtime.get(k)) as T | null) ?? undefined;
      } catch {
        return undefined;
      }
    }),
  );
}

// Request-Coalescing: Läuft für denselben Key bereits ein Fetch in dieser
// Instanz, teilen sich alle Aufrufer dessen Promise statt parallel die API zu
// treffen. Entscheidend für den landesweiten SIRI-SX-Feed (ein großer Fetch,
// viele gleichzeitige Nutzer) und generell für den 20k/Tag-Haushalt.
const inflight = new Map<string, Promise<unknown>>();

/**
 * Liefert den gecachten Wert für `key` oder ruft `fn` auf und cacht dessen
 * Ergebnis für `ttlSec` Sekunden. Fehlerergebnisse werden nicht gecacht, damit
 * ein kurzer API-Ausfall nicht „festgehalten" wird.
 */
export async function cached<T>(key: string, ttlSec: number, fn: () => Promise<T>): Promise<T> {
  const k = full(key);

  const hit = await load<T>(k);
  if (hit !== undefined) return hit;

  const running = inflight.get(k);
  if (running) return (await running) as T;

  const p = (async () => {
    const value = await fn();
    if (!isError(value)) await store(k, value, ttlSec);
    return value;
  })();
  inflight.set(k, p);
  try {
    return await p;
  } finally {
    inflight.delete(k);
  }
}
