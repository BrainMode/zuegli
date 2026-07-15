// Rate-Limiting & Kostenschutz für die öffentliche Demo.
//
// Primär: Upstash Redis (Vercel Marketplace, Free Tier) — nur damit funktioniert
// ein globaler Tages-Cap mit freundlicher Meldung über mehrere Serverless-
// Instanzen hinweg.
// Fallback ohne Upstash-Env: In-Memory pro Lambda-Instanz. Reicht für lokale
// Entwicklung und Forks, die ohne Setup starten sollen — schützt aber NICHT
// zuverlässig eine öffentliche Produktion (jede Instanz zählt eigenständig).

import { Ratelimit } from '@upstash/ratelimit';
import { Redis } from '@upstash/redis';

const PER_IP = Number(process.env.RATE_LIMIT_PER_IP ?? 10); // Nachrichten / 5 min
const PER_IP_DAY = 40; // Nachrichten / IP / Tag
const DAILY_CAP = Number(process.env.DAILY_MESSAGE_CAP ?? 1500); // globaler Tages-Cap

const hasUpstash = Boolean(
  process.env.UPSTASH_REDIS_REST_URL && process.env.UPSTASH_REDIS_REST_TOKEN,
);

// ── Upstash-Pfad ──────────────────────────────────────────────────────────
let redis: Redis | null = null;
let ipLimiter: Ratelimit | null = null;
let ipDayLimiter: Ratelimit | null = null;

if (hasUpstash) {
  redis = Redis.fromEnv();
  ipLimiter = new Ratelimit({
    redis,
    limiter: Ratelimit.slidingWindow(PER_IP, '5 m'),
    prefix: 'zuegli:ip5m',
    analytics: false,
  });
  ipDayLimiter = new Ratelimit({
    redis,
    limiter: Ratelimit.slidingWindow(PER_IP_DAY, '1 d'),
    prefix: 'zuegli:ipday',
    analytics: false,
  });
}

// ── In-Memory-Fallback ──────────────────────────────────────────────────────
type Bucket = { count: number; resetAt: number };
const memWindows = new Map<string, Bucket>();
let memDailyDate = '';
let memDailyCount = 0;

function memoryLimit(key: string, limit: number, windowMs: number): boolean {
  const now = Date.now();
  const b = memWindows.get(key);
  if (!b || b.resetAt < now) {
    memWindows.set(key, { count: 1, resetAt: now + windowMs });
    return true;
  }
  if (b.count >= limit) return false;
  b.count += 1;
  return true;
}

function today(): string {
  return new Date().toISOString().slice(0, 10);
}

export type LimitVerdict = { ok: true } | { ok: false; kind: 'ratelimit' | 'budget' };

/** Prüft vor jedem LLM-Spend die IP- und globalen Limits. */
export async function checkLimits(ip: string): Promise<LimitVerdict> {
  const date = today();

  if (hasUpstash && redis && ipLimiter && ipDayLimiter) {
    // Globaler Tages-Cap
    const globalKey = `zuegli:global:${date}`;
    const used = await redis.incr(globalKey);
    if (used === 1) await redis.expire(globalKey, 90_000);
    if (used > DAILY_CAP) return { ok: false, kind: 'budget' };

    // Pro-IP-Limits
    const [win, day] = await Promise.all([
      ipLimiter.limit(ip),
      ipDayLimiter.limit(ip),
    ]);
    if (!win.success || !day.success) return { ok: false, kind: 'ratelimit' };
    return { ok: true };
  }

  // In-Memory-Fallback
  if (memDailyDate !== date) {
    memDailyDate = date;
    memDailyCount = 0;
  }
  memDailyCount += 1;
  if (memDailyCount > DAILY_CAP) return { ok: false, kind: 'budget' };
  if (!memoryLimit(`ip5m:${ip}`, PER_IP, 5 * 60_000)) return { ok: false, kind: 'ratelimit' };
  if (!memoryLimit(`ipday:${ip}`, PER_IP_DAY, 24 * 60 * 60_000))
    return { ok: false, kind: 'ratelimit' };
  return { ok: true };
}

/** Akkumuliert verbrauchte Tokens (für spätere Kostenauswertung). Best effort. */
export async function trackTokens(inputTokens: number, outputTokens: number): Promise<void> {
  if (!hasUpstash || !redis) return;
  const date = today();
  try {
    await Promise.all([
      redis.incrby(`zuegli:tok:in:${date}`, inputTokens),
      redis.incrby(`zuegli:tok:out:${date}`, outputTokens),
    ]);
  } catch {
    // Reporting ist unkritisch — Fehler schlucken.
  }
}

/** Ermittelt die Client-IP aus den üblichen Proxy-Headern. */
export function clientIp(req: Request): string {
  const xff = req.headers.get('x-forwarded-for');
  if (xff) return xff.split(',')[0].trim();
  return req.headers.get('x-real-ip') ?? '127.0.0.1';
}
