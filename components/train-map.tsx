'use client';

// Live-Karte: alle ÖV-Fahrzeuge der Schweiz als animierte Punkte.
// Daten: /api/trains?tier=1..4 (Tier-Snapshots, 60-s-Refresh nur für aktive
// Tiers). Positionen werden client-seitig aus den absoluten Halt-Zeiten
// interpoliert (lib/map/position.ts). LOD: Tiers erscheinen zoomabhängig
// (TIER_MIN_ZOOM) und sind per Chips filterbar; animiert wird nur, was das
// gepufferte Viewport schneidet (Ressourcen).

import { useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import maplibregl from 'maplibre-gl';
import 'maplibre-gl/dist/maplibre-gl.css';
import {
  trainPosition,
  TIER_COLORS,
  TIER_LABELS,
  TIER_MIN_ZOOM,
  type LiveCall,
  type Segment,
} from '@/lib/map/position';

const STYLE_URL = 'https://vectortiles.geo.admin.ch/styles/ch.swisstopo.lightbasemap.vt/style.json';
const RASTER_FALLBACK: maplibregl.StyleSpecification = {
  version: 8,
  sources: {
    swisstopo: {
      type: 'raster',
      tiles: [
        'https://wmts.geo.admin.ch/1.0.0/ch.swisstopo.pixelkarte-grau/default/current/3857/{z}/{x}/{y}.jpeg',
      ],
      tileSize: 256,
      attribution: '© swisstopo',
    },
  },
  layers: [{ id: 'swisstopo', type: 'raster', source: 'swisstopo' }],
};

type LiveTrain = {
  r: string;
  l: string;
  n: string | null;
  d: string;
  m: 1 | 2 | 3 | 4;
  x?: 1;
  dl?: number;
  ns?: string;
  ni?: number;
  c: LiveCall[];
};

type TrainWithBBox = LiveTrain & { bbox: [number, number, number, number] };

function routeBBox(c: LiveCall[]): [number, number, number, number] {
  let minLon = Infinity, minLat = Infinity, maxLon = -Infinity, maxLat = -Infinity;
  for (const [lon, lat] of c) {
    if (lon < minLon) minLon = lon;
    if (lat < minLat) minLat = lat;
    if (lon > maxLon) maxLon = lon;
    if (lat > maxLat) maxLat = lat;
  }
  return [minLon, minLat, maxLon, maxLat];
}

export default function TrainMap() {
  const containerRef = useRef<HTMLDivElement>(null);
  const mapRef = useRef<maplibregl.Map | null>(null);
  const tiersData = useRef<Map<number, { t: number; trains: TrainWithBBox[] }>>(new Map());
  // Leer starten: ensureTiers() fetcht beim Map-Load alle zoom-relevanten Tiers
  // (ein vorbefülltes Set würde den Initial-Fetch von Tier 1 unterdrücken).
  const activeTiers = useRef<Set<number>>(new Set());
  const enabledRef = useRef<Record<number, boolean>>({ 1: true, 2: true, 3: true, 4: true });
  const viewBBox = useRef<[number, number, number, number]>([-180, -90, 180, 90]);
  // Fahrweg-Segmente: pairKey → Polyline | null (kein Fahrweg) | fehlt (=nie gefragt).
  const segments = useRef<Map<string, Segment | null>>(new Map());
  const wantedPairs = useRef<Set<string>>(new Set());
  const pendingPairs = useRef<Set<string>>(new Set());
  const [enabled, setEnabled] = useState<Record<number, boolean>>({ 1: true, 2: true, 3: true, 4: true });
  const [stale, setStale] = useState(false);
  const [count, setCount] = useState(0);
  const [errMsg, setErrMsg] = useState<string | null>(null);
  const countRef = useRef(0);

  useEffect(() => {
    enabledRef.current = enabled;
  }, [enabled]);

  useEffect(() => {
    if (!containerRef.current) return;
    const map = new maplibregl.Map({
      container: containerRef.current,
      style: STYLE_URL,
      center: [8.23, 46.82],
      zoom: 7.3,
      minZoom: 6,
      maxZoom: 16,
      attributionControl: { customAttribution: '© swisstopo · Daten: opentransportdata.swiss' },
    });
    mapRef.current = map;
    // Fehler sichtbar machen (die Karte ist ihr eigener Debugger) — aber KEIN
    // Hair-Trigger-Fallback: einzelne Tile-/Glyph-Fehler während des Style-
    // Loads dürfen den Load-Zyklus nicht per setStyle verklemmen.
    let usedFallback = false;
    map.on('error', (e) => {
      const msg = (e as { error?: { message?: string } }).error?.message ?? 'unbekannter Kartenfehler';
      console.error('[karte]', msg);
      setErrMsg(msg);
    });
    const styleFallback = setTimeout(() => {
      if (!map.isStyleLoaded() && !usedFallback) {
        usedFallback = true;
        setErrMsg(null);
        try {
          map.setStyle(RASTER_FALLBACK);
        } catch {
          /* noop */
        }
      }
    }, 7000);
    map.addControl(new maplibregl.NavigationControl({ showCompass: false }), 'top-right');

    let raf = 0;
    let lastFrame = 0;
    let fetchTimer: ReturnType<typeof setInterval> | null = null;
    let disposed = false;

    const updateViewBBox = () => {
      const b = map.getBounds();
      const padLon = (b.getEast() - b.getWest()) * 0.3;
      const padLat = (b.getNorth() - b.getSouth()) * 0.3;
      viewBBox.current = [
        b.getWest() - padLon,
        b.getSouth() - padLat,
        b.getEast() + padLon,
        b.getNorth() + padLat,
      ];
    };

    const wantedTiers = (): number[] => {
      const z = map.getZoom();
      return [1, 2, 3, 4].filter((t) => z >= TIER_MIN_ZOOM[t]);
    };

    const fetchTier = async (t: number) => {
      try {
        const res = await fetch(`/api/trains?tier=${t}`);
        if (!res.ok) return;
        const data = (await res.json()) as { t: number; trains: LiveTrain[] };
        tiersData.current.set(t, {
          t: data.t,
          trains: data.trains.map((tr) => ({ ...tr, bbox: routeBBox(tr.c) })),
        });
        setStale(Date.now() / 1000 - data.t > 180);
      } catch {
        /* nächster Refresh versucht es erneut */
      }
    };

    const ensureTiers = () => {
      for (const t of wantedTiers()) {
        if (!activeTiers.current.has(t)) {
          activeTiers.current.add(t);
          void fetchTier(t);
        }
      }
    };

    const refreshActive = () => {
      if (document.hidden) return;
      for (const t of activeTiers.current) void fetchTier(t);
    };

    // Fahrweg-Segmente nachladen: alle 2.5 s bis zu 40 der gerade gebrauchten
    // Paare anfragen. Der Server lernt Unbekannte nach und nach von OJP —
    // ausbleibende Antworten einfach beim nächsten Tick erneut versuchen.
    const SEG_LRU_MAX = 4000;
    const askedAt = new Map<string, number>(); // Cooldown: Paar nicht öfter als alle 12 s anfragen
    const segTimer = setInterval(async () => {
      if (document.hidden || wantedPairs.current.size === 0) return;
      const now = Date.now();
      const batch = [...wantedPairs.current]
        .filter((p) => !pendingPairs.current.has(p) && (askedAt.get(p) ?? 0) < now - 12_000)
        .slice(0, 40);
      wantedPairs.current.clear();
      if (batch.length === 0) return;
      for (const p of batch) {
        pendingPairs.current.add(p);
        askedAt.set(p, now);
      }
      if (askedAt.size > 8000) askedAt.clear();
      try {
        const res = await fetch(`/api/shape?pairs=${batch.join(',')}`);
        if (res.ok) {
          const data = (await res.json()) as { segments: Record<string, Segment | null> };
          for (const [pair, seg] of Object.entries(data.segments)) {
            if (segments.current.size >= SEG_LRU_MAX) {
              const oldest = segments.current.keys().next().value;
              if (oldest !== undefined) segments.current.delete(oldest);
            }
            segments.current.set(pair, seg);
          }
        }
      } catch {
        /* nächster Tick */
      } finally {
        for (const p of batch) pendingPairs.current.delete(p);
      }
    }, 4000);

    const bboxIntersects = (a: [number, number, number, number]) => {
      const v = viewBBox.current;
      return a[0] <= v[2] && a[2] >= v[0] && a[1] <= v[3] && a[3] >= v[1];
    };

    // Debug-Fenster (harmlos in Prod): Zustand des Render-Loops einsehbar.
    const dbg = { frames: 0, srcMissing: 0, lastFeatures: 0, skipTier: 0, skipBBox: 0, skipPos: 0, segs: 0, segWanted: 0 };
    const w = window as unknown as Record<string, unknown>;
    w.__zuegliDbg = dbg;
    w.__zuegliMap = map;

    const frame = (ts: number) => {
      raf = requestAnimationFrame(frame);
      if (ts - lastFrame < 100) return; // ~10 fps reicht für ruhige Bewegung
      lastFrame = ts;
      if (document.hidden) return;
      dbg.frames++;
      const src = map.getSource('trains') as maplibregl.GeoJSONSource | undefined;
      if (!src) {
        dbg.srcMissing++;
        return;
      }
      const nowSec = Date.now() / 1000;
      const z = map.getZoom();
      const features: GeoJSON.Feature[] = [];
      for (const t of [1, 2, 3, 4]) {
        if (z < TIER_MIN_ZOOM[t] || !enabledRef.current[t]) {
          dbg.skipTier++;
          continue;
        }
        const tier = tiersData.current.get(t);
        if (!tier) continue;
        for (const tr of tier.trains) {
          if (tr.x) continue; // ausgefallene Fahrten nicht zeichnen
          if (!bboxIntersects(tr.bbox)) {
            dbg.skipBBox++;
            continue; // Viewport-Culling
          }
          // Verkehrsmittel-Klasse in den Segment-Key (ein ZUG-Paar darf nie die
          // Geometrie einer parallelen BUS-Verbindung erben und umgekehrt).
          const cls = tr.m <= 2 ? 'r' : tr.m === 3 ? 't' : 'b';
          const pos = trainPosition(
            tr.c,
            nowSec,
            (pair) => segments.current.get(`${cls}:${pair}`),
            (pair) => {
              const key = `${cls}:${pair}`;
              if (!pendingPairs.current.has(key)) wantedPairs.current.add(key);
            },
          );
          if (!pos) {
            dbg.skipPos++;
            continue;
          }
          // "Nächster Halt"/Verspätung nur zeigen, solange das Fahrzeug den
          // Snapshot-Referenzhalt (ni) noch nicht passiert hat — sonst zeigte
          // das Popup bis zum nächsten Snapshot einen bereits passierten Halt
          // (wirkte wie "fährt in die falsche Richtung").
          const nsFresh = tr.ni !== undefined && pos.next === tr.ni;
          features.push({
            type: 'Feature',
            geometry: { type: 'Point', coordinates: [pos.lon, pos.lat] },
            properties: {
              color: TIER_COLORS[tr.m],
              line: tr.l,
              num: tr.n ?? '',
              dir: tr.d,
              dl: nsFresh ? (tr.dl ?? 0) : 0,
              ns: nsFresh ? (tr.ns ?? '') : '',
            },
          });
        }
      }
      dbg.lastFeatures = features.length;
      dbg.segs = segments.current.size;
      dbg.segWanted = wantedPairs.current.size;
      if (countRef.current !== features.length) {
        countRef.current = features.length;
        setCount(features.length);
      }
      src.setData({ type: 'FeatureCollection', features });
    };

    map.on('load', () => {
      if (disposed) return;
      clearTimeout(styleFallback);
      setErrMsg(null);
      updateViewBBox();
      map.addSource('trains', { type: 'geojson', data: { type: 'FeatureCollection', features: [] } });
      map.addLayer({
        id: 'trains',
        type: 'circle',
        source: 'trains',
        paint: {
          'circle-radius': ['interpolate', ['linear'], ['zoom'], 7, 3, 12, 7],
          'circle-color': ['get', 'color'],
          'circle-stroke-color': '#ffffff',
          'circle-stroke-width': 1.2,
        },
      });
      map.on('click', 'trains', (e) => {
        const f = e.features?.[0];
        if (!f) return;
        const p = f.properties as Record<string, string>;
        const dl = Number(p.dl);
        new maplibregl.Popup({ closeButton: false, offset: 10 })
          .setLngLat((f.geometry as GeoJSON.Point).coordinates as [number, number])
          .setHTML(
            `<div style="font: 13px/1.4 'Helvetica Neue',Arial,sans-serif; color:#212121">
               <strong>${p.line}${p.num && p.num !== p.line ? ` (${p.num})` : ''}</strong> → ${p.dir}<br/>
               ${dl > 0 ? `<span style="color:#e00514">+${dl} min</span> · ` : ''}
               ${p.ns ? `Nächster Halt: ${p.ns}` : ''}
             </div>`,
          )
          .addTo(map);
      });
      map.on('mouseenter', 'trains', () => (map.getCanvas().style.cursor = 'pointer'));
      map.on('mouseleave', 'trains', () => (map.getCanvas().style.cursor = ''));

      ensureTiers();
      raf = requestAnimationFrame(frame);
      fetchTimer = setInterval(refreshActive, 60_000);
    });

    map.on('moveend', () => {
      updateViewBBox();
      ensureTiers();
    });
    const onVisible = () => {
      if (!document.hidden) refreshActive();
    };
    document.addEventListener('visibilitychange', onVisible);

    return () => {
      disposed = true;
      clearTimeout(styleFallback);
      cancelAnimationFrame(raf);
      if (fetchTimer) clearInterval(fetchTimer);
      clearInterval(segTimer);
      document.removeEventListener('visibilitychange', onVisible);
      map.remove();
      mapRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    // h-dvh (nicht min-h!): flex-1 braucht eine echte Parent-Höhe, sonst
    // kollabiert der absolute Karten-Container auf 0 (headless verifiziert).
    <div className="flex h-dvh flex-col">
      <header className="z-10 shrink-0 bg-[var(--zuegli-red)] shadow-md">
        <div className="mx-auto flex max-w-6xl items-center gap-3 px-4 py-3">
          <span className="zuegli-logo text-lg">Z</span>
          <div className="min-w-0 flex-1">
            <h1 className="truncate text-[17px] font-bold text-white">Zügli · Live-Karte</h1>
            <p className="truncate text-xs text-white/85">
              {count} Fahrzeuge im Bild · Positionen interpoliert
            </p>
          </div>
          <Link
            href="/"
            className="shrink-0 rounded-md border border-white/40 px-3 py-1.5 text-sm font-semibold text-white hover:bg-white/10"
          >
            💬 Chat
          </Link>
        </div>
      </header>

      {stale && (
        <div className="bg-amber-100 px-4 py-1.5 text-center text-xs text-amber-900">
          Datenstand älter als 3 Minuten — Positionen können abweichen.
        </div>
      )}
      {errMsg && (
        <div className="bg-red-100 px-4 py-1.5 text-center text-xs text-red-900">
          Kartenfehler: {errMsg}
        </div>
      )}

      <div className="relative min-h-0 flex-1">
        {/* h-full statt absolute/inset: maplibre-CSS erzwingt position:relative
            auf .maplibregl-map und schlägt Tailwinds absolute (Bundle-Reihenfolge) */}
        <div ref={containerRef} className="h-full w-full" />
        {/* Filter-Chips + Legende */}
        <div className="absolute bottom-6 left-2 z-10 flex flex-col gap-1 rounded-lg bg-white/95 p-2 shadow-md">
          {[1, 2, 3, 4].map((t) => (
            <button
              key={t}
              onClick={() => setEnabled((e) => ({ ...e, [t]: !e[t] }))}
              className={`flex items-center gap-2 rounded px-2 py-1 text-left text-xs font-semibold transition ${
                enabled[t] ? 'text-[var(--ink)]' : 'text-[var(--muted)] opacity-50'
              }`}
            >
              <span
                className="inline-block h-3 w-3 rounded-full border border-white"
                style={{ background: TIER_COLORS[t] }}
              />
              {TIER_LABELS[t]}
              {mapRef.current && mapRef.current.getZoom() < TIER_MIN_ZOOM[t] ? ' (reinzoomen)' : ''}
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}
