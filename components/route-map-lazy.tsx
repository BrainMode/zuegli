'use client';

import dynamic from 'next/dynamic';
import type { RouteStop } from './route-map';

// maplibre-gl nur laden, wenn wirklich eine Karte gerendert wird.
const RouteMap = dynamic(() => import('./route-map'), { ssr: false, loading: () => null });

export default function RouteMapLazy(props: { stops: RouteStop[]; journeyRef?: string | null }) {
  return <RouteMap {...props} />;
}
