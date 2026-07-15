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
  const activeTiers = useRef<Set<number>>(new Set([1]));
  const enabledRef = useRef<Record<number, boolean>>({ 1: true, 2: true, 3: true, 4: true });
  const viewBBox = useRef<[number, number, number, number]>([-180, -90, 180, 90]);
  const [enabled, setEnabled] = useState<Record<number, boolean>>({ 1: true, 2: true, 3: true, 4: true });
  const [stale, setStale] = useState(false);
  const [count, setCount] = useState(0);

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
    map.on('error', (e) => {
      // Vektorstil nicht ladbar → Raster-Fallback (einmalig).
      if (!map.isStyleLoaded() && (e as { error?: { status?: number } }).error) {
        try {
          map.setStyle(RASTER_FALLBACK);
        } catch {
          /* noop */
        }
      }
    });
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

    const bboxIntersects = (a: [number, number, number, number]) => {
      const v = viewBBox.current;
      return a[0] <= v[2] && a[2] >= v[0] && a[1] <= v[3] && a[3] >= v[1];
    };

    const frame = (ts: number) => {
      raf = requestAnimationFrame(frame);
      if (ts - lastFrame < 100) return; // ~10 fps reicht für ruhige Bewegung
      lastFrame = ts;
      if (document.hidden) return;
      const src = map.getSource('trains') as maplibregl.GeoJSONSource | undefined;
      if (!src) return;
      const nowSec = Date.now() / 1000;
      const z = map.getZoom();
      const features: GeoJSON.Feature[] = [];
      for (const t of [1, 2, 3, 4]) {
        if (z < TIER_MIN_ZOOM[t] || !enabledRef.current[t]) continue;
        const tier = tiersData.current.get(t);
        if (!tier) continue;
        for (const tr of tier.trains) {
          if (tr.x) continue; // ausgefallene Fahrten nicht zeichnen
          if (!bboxIntersects(tr.bbox)) continue; // Viewport-Culling
          const pos = trainPosition(tr.c, nowSec);
          if (!pos) continue;
          features.push({
            type: 'Feature',
            geometry: { type: 'Point', coordinates: [pos.lon, pos.lat] },
            properties: {
              color: TIER_COLORS[tr.m],
              line: tr.l,
              num: tr.n ?? '',
              dir: tr.d,
              dl: tr.dl ?? 0,
              ns: tr.ns ?? '',
            },
          });
        }
      }
      setCount(features.length);
      src.setData({ type: 'FeatureCollection', features });
    };

    map.on('load', () => {
      if (disposed) return;
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
      cancelAnimationFrame(raf);
      if (fetchTimer) clearInterval(fetchTimer);
      document.removeEventListener('visibilitychange', onVisible);
      map.remove();
      mapRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <div className="flex min-h-dvh flex-col">
      <header className="z-10 bg-[var(--zuegli-red)] shadow-md">
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

      <div className="relative flex-1">
        <div ref={containerRef} className="absolute inset-0" />
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
