import type { Metadata } from 'next';
import TrainMapLazy from '@/components/train-map-lazy';

export const metadata: Metadata = {
  title: 'Zügli · Live-Karte — Züge, Trams und Busse in Echtzeit',
  description:
    'Alle Züge der Schweiz live auf der Karte — Positionen aus Echtzeit-Fahrplandaten interpoliert. Beim Reinzoomen erscheinen S-Bahn, Tram und Bus.',
  robots: { index: true, follow: true },
};

export default function KartePage() {
  return <TrainMapLazy />;
}
