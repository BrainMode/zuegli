import { refreshLiveMap } from '@/lib/sbb/livemap';

// Minuten-Import des SIRI-ET-Feeds für die Live-Karte. Kosten-Bremsen stecken
// in refreshLiveMap (Nachtdrossel, Overlap-Guard/LIVEMAP_MIN_INTERVAL_SEC).
export const runtime = 'nodejs';
export const maxDuration = 120;

export async function GET(req: Request) {
  const secret = process.env.CRON_SECRET;
  if (secret && req.headers.get('authorization') !== `Bearer ${secret}`) {
    return new Response('Unauthorized', { status: 401 });
  }

  try {
    const result = await refreshLiveMap();
    if (!result.skipped) console.log('[cron:livemap]', JSON.stringify(result));
    return Response.json({ ok: true, ...result });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error('[cron:livemap]', msg);
    return Response.json({ ok: false, error: msg }, { status: 500 });
  }
}
