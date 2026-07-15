// Leichtes Caching für ÖV-Antworten. Wichtigster Quota-Schutz: Fragen 500
// Leute dasselbe, geht es nur EINMAL an die (auf 20k Requests/Tag limitierte)
// Open-Data-API. Nutzt Upstash Redis (falls konfiguriert), sonst einen
// In-Memory-Fallback pro Serverless-Instanz. Fehlerergebnisse ({ error })
// werden NIE gecacht.

import { Redis } from '@upstash/redis';

const hasUpstash = Boolean(
  process.env.UPSTASH_REDIS_REST_URL && process.env.UPSTASH_REDIS_REST_TOKEN,
);
const redis = hasUpstash ? Redis.fromEnv() : null;

type MemEntry = { value: unknown; exp: number };
const mem = new Map<string, MemEntry>();
const MEM_MAX = 500;

function memGet(key: string): unknown {
  const e = mem.get(key);
  if (!e) return undefined;
  if (e.exp < Date.now()) {
    mem.delete(key);
    return undefined;
  }
  return e.value;
}

function memSet(key: string, value: unknown, ttlSec: number) {
  if (mem.size >= MEM_MAX) {
    const oldest = mem.keys().next().value;
    if (oldest) mem.delete(oldest);
  }
  mem.set(key, { value, exp: Date.now() + ttlSec * 1000 });
}

function isError(v: unknown): boolean {
  return Boolean(v && typeof v === 'object' && 'error' in v);
}

/** Direktes Schreiben (für Stale-Kopien u.ä. — im Gegensatz zu cached() wird IMMER überschrieben). */
export async function cachePut(key: string, ttlSec: number, value: unknown): Promise<void> {
  const k = `zuegli:cache:${key}`;
  try {
    if (redis) await redis.set(k, value, { ex: ttlSec });
    else memSet(k, value, ttlSec);
  } catch {
    // best effort
  }
}

/** Direktes Lesen ohne Loader. undefined = kein Treffer. */
export async function cacheGet<T>(key: string): Promise<T | undefined> {
  const k = `zuegli:cache:${key}`;
  try {
    if (redis) {
      const hit = await redis.get<T>(k);
      return hit == null ? undefined : hit;
    }
    const hit = memGet(k);
    return hit === undefined ? undefined : (hit as T);
  } catch {
    return undefined;
  }
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
  const k = `zuegli:cache:${key}`;

  try {
    if (redis) {
      const hit = await redis.get<T>(k);
      if (hit != null) return hit;
    } else {
      const hit = memGet(k);
      if (hit !== undefined) return hit as T;
    }
  } catch {
    // Cache-Lesefehler ignorieren — dann eben frisch laden.
  }

  const running = inflight.get(k);
  if (running) return (await running) as T;

  const p = (async () => {
    const value = await fn();
    if (!isError(value)) {
      try {
        if (redis) await redis.set(k, value, { ex: ttlSec });
        else memSet(k, value, ttlSec);
      } catch {
        // Cache-Schreibfehler sind unkritisch.
      }
    }
    return value;
  })();
  inflight.set(k, p);
  try {
    return await p;
  } finally {
    inflight.delete(k);
  }
}
