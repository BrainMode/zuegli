import { getSegments } from '@/lib/sbb/shapes';

// Fahrweg-Segmente für die Live-Karte: ?pairs=keyA-keyB,keyC-keyD (max 40).
// Bekannte Paare kommen aus dem Cache; wenige Unbekannte werden live von OJP
// gelernt (budget-limitiert) und dauerhaft gecacht.
export const runtime = 'nodejs';
export const maxDuration = 30;

export async function GET(req: Request) {
  const raw = new URL(req.url).searchParams.get('pairs') ?? '';
  const pairs = [...new Set(raw.split(',').map((p) => p.trim()).filter((p) => /^[rtb]:\d+-\d+$/.test(p)))].slice(0, 40);
  if (pairs.length === 0) {
    return Response.json({ error: 'pairs fehlt (Format r|t|b:keyA-keyB,…)' }, { status: 400 });
  }
  const segments = await getSegments(pairs);
  // KEIN CDN-Cache: während der Lernphase wiederholen Clients dieselbe
  // Pair-Liste — eine gecachte Antwort würde das Nachlernen einfrieren
  // (beobachtet: Plateau). Persistenz liegt in Redis + In-Memory.
  return Response.json({ segments }, { headers: { 'Cache-Control': 'no-store' } });
}
