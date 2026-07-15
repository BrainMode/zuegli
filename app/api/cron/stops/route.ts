import { refreshStops } from '@/lib/sbb/stops';

// Täglicher Import der Haltestellen-Stammdaten (Koordinaten für die Live-Karte).
export const runtime = 'nodejs';
export const maxDuration = 300;

export async function GET(req: Request) {
  const secret = process.env.CRON_SECRET;
  if (secret && req.headers.get('authorization') !== `Bearer ${secret}`) {
    return new Response('Unauthorized', { status: 401 });
  }

  try {
    const result = await refreshStops();
    console.log('[cron:stops]', JSON.stringify(result));
    return Response.json({ ok: true, ...result });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error('[cron:stops]', msg);
    return Response.json({ ok: false, error: msg }, { status: 500 });
  }
}
