import type { Metadata, Viewport } from 'next';
import './globals.css';

export const metadata: Metadata = {
  metadataBase: new URL('https://zuegli.ch'),
  title: 'Zügli — KI-Bahnauskunft für die Schweiz',
  description:
    'Inoffizielle KI-Bahnauskunft für die Schweiz in 100+ Sprachen. Frag nach Abfahrten, Verspätungen, Verbindungen, Wagenreihung (mit Perronsektor!), Belegung und Störungen. Open Source.',
  applicationName: 'Zügli',
  openGraph: {
    title: 'Zügli',
    description:
      'KI-Bahnauskunft für die Schweiz in 100+ Sprachen — mit Wagenreihung, Belegungsprognose und Störungsmeldungen. Open Source, europäisches Modell.',
    type: 'website',
    locale: 'de_CH',
    url: 'https://zuegli.ch',
    siteName: 'Zügli',
  },
  twitter: {
    card: 'summary_large_image',
    title: 'Zügli',
    description:
      'KI-Bahnauskunft für die Schweiz in 100+ Sprachen — inoffiziell, Open Source, mit Wagenreihung und Belegungsprognose.',
  },
  robots: { index: true, follow: true },
};

export const viewport: Viewport = {
  themeColor: '#d61e2c',
  width: 'device-width',
  initialScale: 1,
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="de">
      <body className="min-h-full antialiased">{children}</body>
    </html>
  );
}
