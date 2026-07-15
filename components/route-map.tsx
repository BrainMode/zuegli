'use client';

// Inline-Routen-Karte unter Chat-Antworten: Polyline durch die Halte einer
// Verbindung/eines Zuglaufs + optional die interpolierte Live-Position des
// Zuges (/api/trains?ref=). Bewusst kompakt (260 px) und scroll-freundlich
// (kein scrollZoom — das Chat-Scrolling hat Vorrang).

import { useEffect, useRef } from 'react';
import maplibregl from 'maplibre-gl';
import 'maplibre-gl/dist/maplibre-gl.css';
import { trainPosition, type LiveCall } from '@/lib/map/position';

const STYLE_URL = 'https://vectortiles.geo.admin.ch/styles/ch.swisstopo.lightbasemap.vt/style.json';

export type RouteStop = { name: string; lon: number; lat: number; cancelled?: boolean };

export default function RouteMap({
  stops,
  journeyRef,
}: {
  stops: RouteStop[];
  journeyRef?: string | null;
}) {
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!containerRef.current || stops.length < 2) return;
    const map = new maplibregl.Map({
      container: containerRef.current,
      style: STYLE_URL,
      attributionControl: { compact: true, customAttribution: '© swisstopo' },
      scrollZoom: false,
      dragRotate: false,
    });
    map.addControl(new maplibregl.NavigationControl({ showCompass: false }), 'top-right');

    const bounds = new maplibregl.LngLatBounds();
    for (const s of stops) bounds.extend([s.lon, s.lat]);
    map.fitBounds(bounds, { padding: 36, duration: 0, maxZoom: 12 });

    let raf = 0;
    let liveCalls: LiveCall[] | null = null;
    let poll: ReturnType<typeof setInterval> | null = null;
    let disposed = false;

    map.on('load', () => {
      if (disposed) return;
      map.addSource('route', {
        type: 'geojson',
        data: {
          type: 'FeatureCollection',
          features: [
            {
              type: 'Feature',
              geometry: { type: 'LineString', coordinates: stops.map((s) => [s.lon, s.lat]) },
              properties: {},
            },
            ...stops.map((s, i) => ({
              type: 'Feature' as const,
              geometry: { type: 'Point' as const, coordinates: [s.lon, s.lat] },
              properties: {
                end: i === 0 || i === stops.length - 1 ? 1 : 0,
                name: s.name,
              },
            })),
          ],
        },
      });
      map.addLayer({
        id: 'route-line',
        type: 'line',
        source: 'route',
        filter: ['==', ['geometry-type'], 'LineString'],
        paint: { 'line-color': '#e00514', 'line-width': 2.5, 'line-opacity': 0.85 },
      });
      map.addLayer({
        id: 'route-stops',
        type: 'circle',
        source: 'route',
        filter: ['==', ['geometry-type'], 'Point'],
        paint: {
          'circle-radius': ['case', ['==', ['get', 'end'], 1], 5, 3],
          'circle-color': '#ffffff',
          'circle-stroke-color': '#e00514',
          'circle-stroke-width': 2,
        },
      });
      map.on('click', 'route-stops', (e) => {
        const f = e.features?.[0];
        if (!f) return;
        new maplibregl.Popup({ closeButton: false, offset: 8 })
          .setLngLat((f.geometry as GeoJSON.Point).coordinates as [number, number])
          .setText(String((f.properties as { name?: string }).name ?? ''))
          .addTo(map);
      });

      // Live-Punkt: Position des Zuges aus dem Livemap-Snapshot.
      if (journeyRef) {
        map.addSource('live', {
          type: 'geojson',
          data: { type: 'FeatureCollection', features: [] },
        });
        map.addLayer({
          id: 'live-dot',
          type: 'circle',
          source: 'live',
          paint: {
            'circle-radius': 7,
            'circle-color': '#e00514',
            'circle-stroke-color': '#ffffff',
            'circle-stroke-width': 2,
          },
        });
        const fetchLive = async () => {
          try {
            const res = await fetch(`/api/trains?ref=${encodeURIComponent(journeyRef)}`);
            if (!res.ok) {
              liveCalls = null;
              return;
            }
            const data = (await res.json()) as { train?: { c?: LiveCall[] } };
            liveCalls = data.train?.c ?? null;
          } catch {
            liveCalls = null;
          }
        };
        void fetchLive();
        poll = setInterval(() => {
          if (!document.hidden) void fetchLive();
        }, 30_000);

        let last = 0;
        const frame = (ts: number) => {
          raf = requestAnimationFrame(frame);
          if (ts - last < 500) return; // 2 fps reichen für die Mini-Karte
          last = ts;
          const src = map.getSource('live') as maplibregl.GeoJSONSource | undefined;
          if (!src) return;
          const pos = liveCalls ? trainPosition(liveCalls, Date.now() / 1000) : null;
          src.setData({
            type: 'FeatureCollection',
            features: pos
              ? [
                  {
                    type: 'Feature',
                    geometry: { type: 'Point', coordinates: [pos.lon, pos.lat] },
                    properties: {},
                  },
                ]
              : [],
          });
        };
        raf = requestAnimationFrame(frame);
      }
    });

    return () => {
      disposed = true;
      cancelAnimationFrame(raf);
      if (poll) clearInterval(poll);
      map.remove();
    };
    // stops/journeyRef sind pro Message stabil (Tool-Output ändert sich nicht).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  if (stops.length < 2) return null;
  return (
    <div className="mt-2 h-[260px] overflow-hidden rounded-lg border border-[var(--border)]">
      <div ref={containerRef} className="h-full w-full" />
    </div>
  );
}
