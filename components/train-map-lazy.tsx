'use client';

// maplibre-gl ist ein reines Browser-Bundle (~250 KB gzip) → nur client-seitig
// und lazy laden. Next 16 erlaubt ssr:false nur innerhalb von Client-Komponenten,
// daher dieser Wrapper.
import dynamic from 'next/dynamic';

const TrainMap = dynamic(() => import('./train-map'), {
  ssr: false,
  loading: () => (
    <div className="flex min-h-dvh items-center justify-center text-[var(--muted)]">
      Karte lädt …
    </div>
  ),
});

export default function TrainMapLazy() {
  return <TrainMap />;
}
