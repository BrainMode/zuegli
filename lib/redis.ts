// Zentraler, abgesicherter Upstash-Zugang für alle Module.
//
// Warum: Redis ist für Zügli ein Beschleuniger (geteilter Cache, globale
// Zähler, Import-Blobs), aber keine Voraussetzung. Wenn die Datenbank fehlt,
// gesperrt ist (z. B. "reached current Fixed plan limits" im Free-Tier) oder
// nicht erreichbar ist, müssen Chat und MCP trotzdem antworten. Deshalb:
//  - genau EIN Client pro Instanz (statt eines pro Modul),
//  - jeder Aufruf geht über redisTry(): Fehler werden geschluckt und liefern
//    `undefined`, die Aufrufer fallen auf In-Memory zurück,
//  - Circuit-Breaker: nach einem Fehler wird Redis 60 s lang gar nicht mehr
//    angefragt (keine Latenz pro Request, keine Log-Flut),
//  - ein Warn-Log pro Minute und Instanz, damit ein Limit-Problem in den
//    Vercel-Logs sofort sichtbar ist (bisher lief das jahrelang stumm).
//
// Akzeptiert beide Env-Varianten: UPSTASH_REDIS_REST_* (manuell gesetzt) und
// KV_REST_API_* (setzt die Vercel-Marketplace-Integration automatisch).

import { Redis } from '@upstash/redis';

const url = process.env.UPSTASH_REDIS_REST_URL || process.env.KV_REST_API_URL;
const token = process.env.UPSTASH_REDIS_REST_TOKEN || process.env.KV_REST_API_TOKEN;

const client: Redis | null =
  url && token
    ? new Redis({
        url,
        token,
        // Default sind 5 Retries mit exponentiellem Backoff (~4 s) — zu lange
        // für den Chat-Pfad, wenn Redis wirklich weg ist.
        retry: { retries: 2, backoff: (n) => 100 * 2 ** n },
      })
    : null;

const COOLDOWN_MS = 60_000;
let openUntil = 0;
let lastWarn = 0;

/** true, wenn Redis konfiguriert ist (unabhängig vom aktuellen Zustand). */
export const redisConfigured = client !== null;

/**
 * Roher Client NUR für Bibliotheken, die eine Redis-Instanz verlangen
 * (@upstash/ratelimit). Deren Aufrufe trotzdem in redisTry() kapseln.
 */
export const redisClient = client;

/** Client nur, wenn konfiguriert UND der Circuit-Breaker gerade geschlossen ist. */
function available(): Redis | null {
  if (!client) return null;
  return Date.now() < openUntil ? null : client;
}

function fail(op: string, err: unknown) {
  openUntil = Date.now() + COOLDOWN_MS;
  if (Date.now() - lastWarn > COOLDOWN_MS) {
    lastWarn = Date.now();
    const msg = err instanceof Error ? err.message : String(err);
    console.warn(`[redis] ${op} fehlgeschlagen — 60 s In-Memory-Fallback: ${msg.slice(0, 300)}`);
  }
}

/**
 * Führt `fn` gegen Redis aus. Liefert `undefined`, wenn Redis nicht
 * konfiguriert, per Circuit-Breaker pausiert oder der Aufruf fehlgeschlagen ist.
 */
export async function redisTry<T>(op: string, fn: (r: Redis) => Promise<T>): Promise<T | undefined> {
  const r = available();
  if (!r) return undefined;
  try {
    return await fn(r);
  } catch (err) {
    fail(op, err);
    return undefined;
  }
}

/**
 * Zähler mit Ablauf. Das EXPIRE geht nur beim ersten Inkrement raus — im
 * Free-Tier zählt jeder Befehl. undefined = Redis nicht verfügbar.
 */
export async function redisCount(key: string, by: number, ttlSec: number): Promise<number | undefined> {
  return redisTry(`count ${key}`, async (r) => {
    const used = await r.incrby(key, by);
    if (used === by) await r.expire(key, ttlSec);
    return used;
  });
}

// Instanz-lokale Zähler als Notbetrieb, wenn Redis fehlt: zählen nur pro
// Serverless-Instanz, halten aber einen groben Deckel (z. B. OTD-Tagesbudget).
const memCounters = new Map<string, { n: number; exp: number }>();

/** Wie redisCount, fällt aber auf einen Instanz-Zähler zurück (nie undefined). */
export async function countWithFallback(key: string, by: number, ttlSec: number): Promise<number> {
  const used = await redisCount(key, by, ttlSec);
  if (used !== undefined) return used;
  const now = Date.now();
  const c = memCounters.get(key);
  if (!c || c.exp < now) {
    if (memCounters.size > 1000) memCounters.clear();
    memCounters.set(key, { n: by, exp: now + ttlSec * 1000 });
    return by;
  }
  c.n += by;
  return c.n;
}
