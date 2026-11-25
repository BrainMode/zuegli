// Rate-Limiting & Kostenschutz für die öffentliche Demo.
//
// Zwei Pfade, beide instanzübergreifend:
//  1. Upstash Redis, falls konfiguriert UND erreichbar: exakte Sliding-Window-
//     Limits über @upstash/ratelimit.
//  2. Sonst (Standard in Production seit 11/2026): Zähler im Vercel Runtime
//     Cache (lib/cache.ts → sharedCount). Feste Fenster und Read-Modify-Write,
//     also auf ein, zwei Nachrichten ungenau — als Missbrauchs- und
//     Kostendeckel reicht das. Lokal (npm run dev) ist der Runtime Cache ein
//     In-Memory-Cache, die Limits gelten also auch dort.
// Ist Redis gesperrt oder weg, fällt checkLimits automatisch auf Pfad 2
// zurück — nie ein 500er. Die harte Kostenbremse bleibt das Budget-Limit im
// Mistral-Konto.

import { createHash } from 'node:crypto';
import { Ratelimit } from '@upstash/ratelimit';
import { sharedCount } from './cache';
import { redisClient, redisConfigured, redisCount, redisTry } from './redis';

const PER_IP = Number(process.env.RATE_LIMIT_PER_IP ?? 10); // Nachrichten / 5 min
const PER_IP_DAY = 40; // Nachrichten / IP / Tag
const DAILY_CAP = Number(process.env.DAILY_MESSAGE_CAP ?? 1500); // globaler Tages-Cap

// ── Upstash-Pfad ──────────────────────────────────────────────────────────
// Ratelimit braucht einen Redis-Client; Aufrufe laufen trotzdem über
// redisTry(), damit ein gesperrtes/fehlendes Redis nie zum 500er wird.
let ipLimiter: Ratelimit | null = null;
let ipDayLimiter: Ratelimit | null = null;

if (redisClient) {
  ipLimiter = new Ratelimit({
    redis: redisClient,
    limiter: Ratelimit.slidingWindow(PER_IP, '5 m'),
    prefix: 'zuegli:ip5m',
    analytics: false,
  });
  ipDayLimiter = new Ratelimit({
    redis: redisClient,
    limiter: Ratelimit.slidingWindow(PER_IP_DAY, '1 d'),
    prefix: 'zuegli:ipday',
    analytics: false,
  });
}

function today(): string {
  return new Date().toISOString().slice(0, 10);
}

/** IP nur gehasht als Cache-Key — keine Klartext-IPs im Speicher. */
function ipId(ip: string): string {
  return createHash('sha256').update(`zuegli:${ip}`).digest('hex').slice(0, 16);
}

export type LimitVerdict = { ok: true } | { ok: false; kind: 'ratelimit' | 'budget' };

/** Prüft vor jedem LLM-Spend die IP- und globalen Limits. */
export async function checkLimits(ip: string): Promise<LimitVerdict> {
  const date = today();

  if (ipLimiter && ipDayLimiter) {
    // Globaler Tages-Cap
    const used = await redisCount(`zuegli:global:${date}`, 1, 90_000);
    if (used !== undefined) {
      if (used > DAILY_CAP) return { ok: false, kind: 'budget' };
      // Pro-IP-Limits
      const limits = await redisTry('ratelimit', () =>
        Promise.all([ipLimiter!.limit(ip), ipDayLimiter!.limit(ip)]),
      );
      if (limits) {
        const [win, day] = limits;
        if (!win.success || !day.success) return { ok: false, kind: 'ratelimit' };
        return { ok: true };
      }
    }
    // Redis nicht erreichbar/gesperrt → Runtime-Cache-Pfad (kein 500er).
  }

  return sharedCheck(ip, date);
}

/** Runtime-Cache-Pfad: feste Fenster (5 min / Tag), instanzübergreifend. */
async function sharedCheck(ip: string, date: string): Promise<LimitVerdict> {
  const id = ipId(ip);
  const window5m = Math.floor(Date.now() / 300_000);
  const [global, perWindow, perDay] = await Promise.all([
    sharedCount(`global:${date}`, 90_000),
    sharedCount(`ip5m:${id}:${window5m}`, 600),
    sharedCount(`ipday:${id}:${date}`, 90_000),
  ]);
  if (global > DAILY_CAP) return { ok: false, kind: 'budget' };
  if (perWindow > PER_IP || perDay > PER_IP_DAY) return { ok: false, kind: 'ratelimit' };
  return { ok: true };
}

/** Akkumuliert verbrauchte Tokens (für spätere Kostenauswertung). Best effort. */
export async function trackTokens(inputTokens: number, outputTokens: number): Promise<void> {
  if (!redisConfigured) return;
  const date = today();
  // Ein Round-Trip statt zwei; Fehler schluckt redisTry (Reporting ist unkritisch).
  await redisTry('trackTokens', (r) =>
    r
      .pipeline()
      .incrby(`zuegli:tok:in:${date}`, inputTokens)
      .incrby(`zuegli:tok:out:${date}`, outputTokens)
      .exec(),
  );
}

/** Ermittelt die Client-IP aus den üblichen Proxy-Headern. */
export function clientIp(req: Request): string {
  const xff = req.headers.get('x-forwarded-for');
  if (xff) return xff.split(',')[0].trim();
  return req.headers.get('x-real-ip') ?? '127.0.0.1';
}
