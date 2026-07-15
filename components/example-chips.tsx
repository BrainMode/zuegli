'use client';

import { useEffect, useState } from 'react';
import type { Lang } from '@/lib/i18n';
import { STRINGS } from '@/lib/i18n';

function pickThree(arr: string[]): string[] {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a.slice(0, 3);
}

export function ExampleChips({ lang, onPick }: { lang: Lang; onPick: (text: string) => void }) {
  const s = STRINGS[lang];
  // Erster Render deterministisch (SSR-sicher: die ersten drei). Danach client-
  // seitig aus dem vollen Katalog zufällig drei ziehen — bei jedem Laden neu.
  const [items, setItems] = useState<string[]>(() => s.examples.slice(0, 3));

  useEffect(() => {
    setItems(pickThree(s.examples));
  }, [lang, s.examples]);

  return (
    <div className="mx-auto mt-6 flex max-w-2xl flex-col gap-2">
      <p className="mb-1 text-center text-xs font-semibold uppercase tracking-wider text-[var(--muted)]">
        {s.examplesLabel}
      </p>
      {items.map((ex) => (
        <button
          key={ex}
          onClick={() => onPick(ex)}
          className="group rounded-lg border border-[var(--border)] bg-white px-4 py-3 text-left text-sm text-[var(--ink)] transition hover:border-[var(--zuegli-red)] hover:bg-[var(--panel)]"
        >
          <span className="mr-2 text-[var(--zuegli-red)]">🚆</span>
          {ex}
        </button>
      ))}
    </div>
  );
}
