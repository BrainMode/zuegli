import { ImageResponse } from 'next/og';

// Statisches Share-Bild (LinkedIn/X) im SBB-angelehnten Look: rotes Lockup,
// weisse Schrift. Bewusst NICHT SBB-Rot #EB0000, kein Doppelpfeil, kein
// Schweizer Kreuz — share-tauglich und markenrechtlich unbedenklich.
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
          background: '#e00514',
          color: '#ffffff',
          fontFamily: 'Helvetica, Arial, sans-serif',
        }}
      >
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            width: 76,
            height: 76,
            background: '#ffffff',
            color: '#e00514',
            fontSize: 48,
            fontWeight: 700,
            borderRadius: 8,
          }}
        >
          Z
        </div>
        <div
          style={{
            fontSize: 110,
            fontWeight: 700,
            lineHeight: 1.02,
            marginTop: 24,
            display: 'flex',
          }}
        >
          Zügli
        </div>
        <div style={{ fontSize: 42, color: 'rgba(255,255,255,0.92)', marginTop: 26, display: 'flex' }}>
          KI-Bahnauskunft für die Schweiz — inoffiziell
        </div>
        <div
          style={{
            fontSize: 27,
            color: 'rgba(255,255,255,0.75)',
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
