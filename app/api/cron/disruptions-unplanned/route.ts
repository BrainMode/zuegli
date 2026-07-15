import { refreshUnplanned } from '@/lib/sbb/disruptions';

// 2-Minuten-Import des kleinen SIRI-SX-UNPLANNED-Feeds (~0.5 MB) — macht die
// Akut-Störungslage fast live. Geplante Situationen kommen weiterhin aus dem
// täglichen Voll-Feed (/api/cron/disruptions).
export const runtime = 'nodejs';
export const maxDuration = 60;

export async function GET(req: Request) {
  const secret = process.env.CRON_SECRET;
  if (secret && req.headers.get('authorization') !== `Bearer ${secret}`) {
    return new Response('Unauthorized', { status: 401 });
  }

  try {
    const result = await refreshUnplanned();
    console.log('[cron:disruptions-unplanned]', JSON.stringify(result));
    return Response.json({ ok: true, ...result });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error('[cron:disruptions-unplanned]', msg);
    return Response.json({ ok: false, error: msg }, { status: 500 });
  }
}
