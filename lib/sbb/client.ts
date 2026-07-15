// OJP-2.0-Client für opentransportdata.swiss: baut den XML-Envelope, schickt
// den Request (Bearer-Auth) und parst die Antwort namespace-agnostisch.
//
// Anders als bei der DB-Schwester-App (bahn.de hinter Akamai) ist das hier eine
// OFFIZIELLE, dokumentierte API — kein TLS-Fingerprint-Theater, nur ein API-Key
// und dokumentierte Quotas (Gratis-Tier: 50 req/min, 20'000 req/Tag).

import { XMLParser } from 'fast-xml-parser';
import { Redis } from '@upstash/redis';

const OJP_ENDPOINT = process.env.OTD_OJP_ENDPOINT ?? 'https://api.opentransportdata.swiss/ojp20';
const REQUESTOR_REF = 'zuegli';

export class OjpError extends Error {
  constructor(
    msg: string,
    public code?: string,
    public status?: number,
  ) {
    super(msg);
    this.name = 'OjpError';
  }
}

export function xmlEscape(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

/** fast-xml-parser liefert bei EINEM Kind ein Objekt, bei mehreren ein Array. */
export function arr<T>(x: T | T[] | undefined | null): T[] {
  if (x == null) return [];
  return Array.isArray(x) ? x : [x];
}

/**
 * Entpackt OJP-Textknoten: <Name><Text xml:lang="de">Bern</Text></Name> wird je
 * nach Attributen zu 'Bern', { '#text': 'Bern', '@xml:lang': 'de' } oder
 * { Text: … } — dieser Helper holt in allen Fällen den String heraus.
 */
export function txt(node: unknown): string | null {
  if (node == null) return null;
  if (typeof node === 'string' || typeof node === 'number') return String(node);
  const o = node as Record<string, unknown>;
  if ('Text' in o) return txt(o.Text);
  if ('#text' in o) return txt(o['#text']);
  return null;
}

// ── Tages-Budget (Soft-Cap unter der 20k-Quote des Gratis-Tiers) ────────────
const hasUpstash = Boolean(
  process.env.UPSTASH_REDIS_REST_URL && process.env.UPSTASH_REDIS_REST_TOKEN,
);
const redis = hasUpstash ? Redis.fromEnv() : null;
const DAILY_CAP = Number(process.env.OTD_DAILY_CAP ?? 18_000);

export const QUOTA_ERROR = {
  error:
    'Das Tageskontingent der Open-Data-API (opentransportdata.swiss) ist für heute aufgebraucht — morgen geht es weiter.',
};

/** Zählt Upstream-Requests pro Tag; wirft OjpError('quota') über dem Soft-Cap. Best effort. */
async function checkDailyBudget(): Promise<void> {
  if (!redis) return; // ohne Upstash kein globaler Zähler — lokal/Forks unkritisch
  try {
    const key = `zuegli:otd:req:${new Date().toISOString().slice(0, 10)}`;
    const used = await redis.incr(key);
    if (used === 1) await redis.expire(key, 90_000);
    if (used > DAILY_CAP) throw new OjpError('OTD-Tageskontingent erschöpft', 'quota');
  } catch (err) {
    if (err instanceof OjpError) throw err;
    // Redis-Fehler nicht zum Request-Fehler machen.
  }
}

const parser = new XMLParser({
  // Macht siri:/ojp:/Default-Namespace-Wirrwarr egal: alle Prefixe fallen weg.
  removeNSPrefix: true,
  ignoreAttributes: false,
  attributeNamePrefix: '@',
});

function envelope(serviceXml: string): string {
  const now = new Date().toISOString();
  return `<?xml version="1.0" encoding="UTF-8"?>
<OJP xmlns="http://www.vdv.de/ojp" xmlns:siri="http://www.siri.org.uk/siri" version="2.0">
  <OJPRequest>
    <siri:ServiceRequest>
      <siri:ServiceRequestContext><siri:Language>de</siri:Language></siri:ServiceRequestContext>
      <siri:RequestTimestamp>${now}</siri:RequestTimestamp>
      <siri:RequestorRef>${REQUESTOR_REF}</siri:RequestorRef>
      ${serviceXml}
    </siri:ServiceRequest>
  </OJPRequest>
</OJP>`;
}

async function post(endpoint: string, body: string): Promise<string> {
  const key = process.env.OTD_API_KEY;
  if (!key) throw new OjpError('OTD_API_KEY fehlt', 'nicht_konfiguriert');
  await checkDailyBudget();

  const res = await fetch(endpoint, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/xml',
      Authorization: `Bearer ${key}`,
      'User-Agent': 'zuegli (open-source; github.com/BrainMode/zuegli)',
    },
    body,
    signal: AbortSignal.timeout(10_000),
  });
  if (!res.ok) throw new OjpError(`OJP HTTP ${res.status}`, 'http', res.status);
  return res.text();
}

/** true bei transienten Fehlern (5xx/Timeout/Netz) — genau EIN Retry, kein Sturm. */
function isTransient(err: unknown): boolean {
  if (err instanceof OjpError) return err.status != null && err.status >= 500;
  const msg = (err instanceof Error ? err.message : String(err)).toLowerCase();
  return /timeout|abort|network|fetch failed|econnreset/.test(msg);
}

/**
 * Schickt EIN OJP-Service-Request-Fragment (z.B. <OJPStopEventRequest>…) an den
 * ojp20-Endpoint und liefert das geparste Delivery-Objekt (prefix-frei) zurück.
 * Wirft OjpError bei HTTP-, Status- oder ErrorCondition-Fehlern.
 */
export async function ojpRequest(
  serviceXml: string,
  deliveryName: string,
): Promise<Record<string, unknown>> {
  const body = envelope(serviceXml);
  let raw: string;
  try {
    raw = await post(OJP_ENDPOINT, body);
  } catch (err) {
    if (!isTransient(err)) throw err;
    raw = await post(OJP_ENDPOINT, body); // 1 Retry bei 5xx/Timeout
  }
  return extractDelivery(raw, deliveryName);
}

/** Für Actions, die zusätzlich das Roh-XML brauchen (z.B. Trip-XML für Preise). */
export async function ojpRequestRaw(
  serviceXml: string,
  deliveryName: string,
): Promise<{ delivery: Record<string, unknown>; raw: string }> {
  const body = envelope(serviceXml);
  let raw: string;
  try {
    raw = await post(OJP_ENDPOINT, body);
  } catch (err) {
    if (!isTransient(err)) throw err;
    raw = await post(OJP_ENDPOINT, body);
  }
  return { delivery: extractDelivery(raw, deliveryName), raw };
}

function extractDelivery(rawXml: string, deliveryName: string): Record<string, unknown> {
  const doc = parser.parse(rawXml) as Record<string, any>;
  const serviceDelivery = doc?.OJP?.OJPResponse?.ServiceDelivery;
  const delivery = serviceDelivery?.[deliveryName];
  if (!delivery) {
    throw new OjpError(`OJP-Antwort ohne ${deliveryName}`, 'shape');
  }
  // Logische Fehler kommen mit HTTP 200: Status=false + ErrorCondition.
  if (String(delivery.Status) === 'false') {
    const cond = delivery.ErrorCondition ?? {};
    const textOf = (n: unknown) => txt(n) ?? undefined;
    const desc =
      textOf(cond.Description) ??
      textOf(cond.OtherError?.ErrorText) ??
      textOf(cond.ServiceNotAvailableError?.Description) ??
      'unbekannter OJP-Fehler';
    // NO_RESULTS o.ä. sind fachlich leere Ergebnisse, keine Ausfälle — der
    // Aufrufer entscheidet anhand des codes.
    throw new OjpError(desc, 'ojp_status');
  }
  return delivery as Record<string, unknown>;
}

/** GET-Helfer für die REST-Zusatzdienste (Formation, SIRI-SX, Belegung). */
export async function otdGet(
  url: string,
  opts: { key?: string; accept?: string } = {},
): Promise<Response> {
  const key = opts.key ?? process.env.OTD_API_KEY;
  if (!key) throw new OjpError('OTD_API_KEY fehlt', 'nicht_konfiguriert');
  await checkDailyBudget();
  const res = await fetch(url, {
    headers: {
      Authorization: `Bearer ${key}`,
      Accept: opts.accept ?? 'application/json',
      'User-Agent': 'zuegli (open-source; github.com/BrainMode/zuegli)',
    },
    signal: AbortSignal.timeout(15_000),
  });
  if (!res.ok) throw new OjpError(`OTD HTTP ${res.status}`, 'http', res.status);
  return res;
}

export { parser as ojpParser };
