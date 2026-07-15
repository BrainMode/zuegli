import { refreshOccupancyData } from '@/lib/sbb/occupancy';

// Täglicher Import der Belegungsprognose (siehe vercel.json → crons).
// Lädt das ~140-MB-Tages-ZIP von opentransportdata.swiss, kompaktiert pro Zug
// und legt pro Betreiber+Tag einen kleinen Blob in den Cache. Läuft bewusst
// NICHT im Chat-Request-Pfad.
export const runtime = 'nodejs';
export const maxDuration = 300;

export async function GET(req: Request) {
  // Vercel Cron schickt Authorization: Bearer <CRON_SECRET>, wenn gesetzt.
  const secret = process.env.CRON_SECRET;
  if (secret && req.headers.get('authorization') !== `Bearer ${secret}`) {
    return new Response('Unauthorized', { status: 401 });
  }

  try {
    const result = await refreshOccupancyData();
    console.log('[cron:occupancy]', JSON.stringify(result.written));
    return Response.json({ ok: true, ...result });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error('[cron:occupancy]', msg);
    return Response.json({ ok: false, error: msg }, { status: 500 });
  }
}
