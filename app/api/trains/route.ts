import { readTier, findTrain } from '@/lib/sbb/livemap';

// Öffentliche Datenquelle der Live-Karte.
//  ?tier=1..4  → kompletter Tier-Snapshot als gzip-Pass-through (CDN-cachebar)
//  ?ref=<journeyRef> → einzelner Zug (für die Chat-Routen-Karten)
// Der Snapshot wird bei Bedarf in dieser Instanz gebaut (~5–20 s, bei
// Feed-Rate-Limit plus bis zu ~1 min Wartezeit — siehe livemap.ts).
export const runtime = 'nodejs';
export const maxDuration = 120;

export async function GET(req: Request) {
  const url = new URL(req.url);
  const ref = url.searchParams.get('ref');

  if (ref) {
    const hit = await findTrain(ref.trim());
    if (!hit) {
      return Response.json(
        { error: 'nicht_gefunden' },
        { status: 404, headers: { 'Cache-Control': 'public, s-maxage=20, stale-while-revalidate=60' } },
      );
    }
    return Response.json(hit, {
      headers: { 'Cache-Control': 'public, s-maxage=20, stale-while-revalidate=60' },
    });
  }

  const tierNum = Number(url.searchParams.get('tier') ?? '1');
  if (![1, 2, 3, 4].includes(tierNum)) {
    return Response.json({ error: 'tier muss 1–4 sein' }, { status: 400 });
  }
  const gz = await readTier(tierNum as 1 | 2 | 3 | 4);
  if (!gz) {
    return Response.json(
      { error: 'keine_daten' },
      { status: 503, headers: { 'Cache-Control': 'no-store', 'Retry-After': '30' } },
    );
  }
  // Snapshot ist bereits gzip — direkt durchreichen spart Re-Kompression und Bytes.
  return new Response(new Uint8Array(gz), {
    headers: {
      'Content-Type': 'application/json',
      'Content-Encoding': 'gzip',
      'Cache-Control': 'public, s-maxage=30, stale-while-revalidate=120',
    },
  });
}
