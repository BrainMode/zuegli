import { refreshDisruptions } from '@/lib/sbb/disruptions';

// 30-Min-Import der SIRI-SX-Störungslage (siehe vercel.json → crons).
// Das Abo erlaubt nur 48 Abfragen/Tag — genau die Cron-Kadenz; ein Tages-
// zähler in lib/sbb/disruptions.ts puffert zusätzlich. Läuft bewusst NICHT
// im Chat-Request-Pfad (Feed ist ~106 MB XML hinter einem Redirect).
export const runtime = 'nodejs';
export const maxDuration = 300;

export async function GET(req: Request) {
  const secret = process.env.CRON_SECRET;
  if (secret && req.headers.get('authorization') !== `Bearer ${secret}`) {
    return new Response('Unauthorized', { status: 401 });
  }

  try {
    const result = await refreshDisruptions();
    console.log('[cron:disruptions]', JSON.stringify(result));
    return Response.json({ ok: true, ...result });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error('[cron:disruptions]', msg);
    return Response.json({ ok: false, error: msg }, { status: 500 });
  }
}
