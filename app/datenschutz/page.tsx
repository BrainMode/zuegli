import type { Metadata } from 'next';
import Link from 'next/link';
import { getOwner } from '@/lib/owner';

export const metadata: Metadata = {
  title: 'Datenschutz — Zügli',
  robots: { index: true, follow: true },
};

export default function DatenschutzPage() {
  const owner = getOwner();

  return (
    <div className="min-h-dvh bg-[var(--bg)]">
      <header className="border-b border-[var(--border)] bg-white">
        <div className="mx-auto flex max-w-2xl items-center gap-3 px-4 py-3">
          <Link href="/" className="zuegli-logo text-base">
            Z
          </Link>
          <span className="text-sm text-[var(--muted)]">Datenschutz</span>
        </div>
      </header>

      <main className="mx-auto max-w-2xl px-4 py-8 text-[15px] leading-relaxed text-[var(--ink)]">
        <h1 className="text-2xl font-bold">Datenschutz</h1>

        {!owner ? (
          <p className="mt-4 text-[var(--muted)]">
            Für diese Instanz sind keine Betreiber-Angaben hinterlegt. Wer diese App selbst betreibt,
            trägt Verantwortlichen, Impressum und Kontakt über die Umgebungsvariablen
            <code className="mx-1 rounded bg-[var(--panel)] px-1 py-0.5 font-mono text-[13px]">
              OWNER_NAME
            </code>
            ,
            <code className="mx-1 rounded bg-[var(--panel)] px-1 py-0.5 font-mono text-[13px]">
              OWNER_ADDRESS
            </code>
            {' '}und{' '}
            <code className="mx-1 rounded bg-[var(--panel)] px-1 py-0.5 font-mono text-[13px]">
              OWNER_IMPRINT_URL
            </code>{' '}
            ein (siehe <code className="font-mono text-[13px]">.env.example</code>).
          </p>
        ) : (
          <>
            <p className="mt-4 text-[var(--muted)]">
              Diese Seite ist ein inoffizielles, kostenloses Projekt und sammelt so wenig Daten wie
              möglich. Es gibt keine Nutzerkonten und keine Werbe- oder Analyse-Tracker.
            </p>

            <Section title="Verantwortlich">
              {owner.name}, {owner.address}. Kontakt über das{' '}
              <a
                href={owner.contactUrl}
                className="text-[var(--zuegli-red)] underline"
                target="_blank"
                rel="noopener noreferrer"
              >
                Impressum
              </a>
              .
            </Section>

            <Section title="Deine Chat-Eingaben">
              Deine Nachricht wird zur Beantwortung an die Mistral-API (Mistral AI, Frankreich/EU)
              übertragen — an das Sprachmodell für die Antwort und an eine Moderationsprüfung, die
              Missbrauch abfängt. Laut Mistral werden über die API übermittelte Inhalte nicht zum
              Training der Modelle verwendet. Deine Chat-Verläufe werden nicht dauerhaft auf eigenen
              Servern gespeichert.
            </Section>

            <Section title="IP-Adresse">
              Zum Schutz vor Missbrauch und zur Begrenzung der Kosten (Rate-Limiting) wird deine
              IP-Adresse kurzzeitig verarbeitet — als Schlüssel für Zähler, die nach spätestens 24
              Stunden ablaufen. Dafür nutzen wir Upstash (Redis). Zusätzlich zählen wir nur die
              Gesamtzahl verarbeiteter Textbausteine (Tokens) pro Tag, ohne Personenbezug.
            </Section>

            <Section title="Hosting">
              Die Website läuft bei Vercel. Wie bei jedem Webserver fallen dabei technisch notwendige
              Verbindungsdaten (u. a. IP-Adresse) an.
            </Section>

            <Section title="Fahrplandaten">
              Für die Auskünfte fragen wir die offene Datenplattform Mobilität Schweiz ab
              (opentransportdata.swiss, Bundesamt für Verkehr/SKI). Dabei werden keine
              personenbezogenen Daten von dir an diese Dienste übermittelt.
            </Section>

            <Section title="Fragen">
              Fragen zum Datenschutz? Melde dich bei {owner.name} (siehe{' '}
              <a
                href={owner.contactUrl}
                className="text-[var(--zuegli-red)] underline"
                target="_blank"
                rel="noopener noreferrer"
              >
                Impressum
              </a>
              ).
            </Section>

            <p className="mt-8 text-xs text-[var(--muted)]">Stand: Juli 2026.</p>
          </>
        )}

        <p className="mt-6">
          <Link href="/" className="text-[var(--zuegli-red)] underline">
            ← Zurück zur Auskunft
          </Link>
        </p>
      </main>
    </div>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="mt-6">
      <h2 className="text-base font-bold">{title}</h2>
      <p className="mt-1.5 text-[var(--muted)]">{children}</p>
    </section>
  );
}
