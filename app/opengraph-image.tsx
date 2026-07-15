import { ImageResponse } from 'next/og';

// Statisches Share-Bild (LinkedIn/X). Bewusst dunkel und OHNE SBB-Farbwelt/
// SBB-Logo/Schweizer Kreuz — neutrales Design, damit die Vorschau share-tauglich
// und markenrechtlich unbedenklich ist.
export const size = { width: 1200, height: 630 };
export const contentType = 'image/png';
export const alt = 'Zügli — KI-Bahnauskunft für die Schweiz (inoffiziell)';

export default function OpengraphImage() {
  return new ImageResponse(
    (
      <div
        style={{
          width: '100%',
          height: '100%',
          display: 'flex',
          flexDirection: 'column',
          justifyContent: 'center',
          padding: '90px',
          background: 'linear-gradient(135deg, #0b1220 0%, #131b2b 100%)',
          color: '#ffffff',
          fontFamily: 'sans-serif',
        }}
      >
        <div
          style={{
            fontSize: 34,
            letterSpacing: 8,
            color: '#7d8aa0',
            fontWeight: 700,
          }}
        >
          🚂
        </div>
        <div
          style={{
            fontSize: 104,
            fontWeight: 700,
            lineHeight: 1.02,
            marginTop: 20,
            display: 'flex',
          }}
        >
          Zügli
        </div>
        <div style={{ fontSize: 44, color: '#b9c2d0', marginTop: 30, display: 'flex' }}>
          KI-Bahnauskunft für die Schweiz — inoffiziell
        </div>
        <div
          style={{
            fontSize: 28,
            color: '#5f6b80',
            marginTop: 'auto',
            display: 'flex',
            gap: 16,
          }}
        >
          <span>zuegli.ch</span>
          <span>·</span>
          <span>Open Source · 100+ Sprachen · Wagenreihung & Belegung</span>
        </div>
      </div>
    ),
    { ...size },
  );
}
