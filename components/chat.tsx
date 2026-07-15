'use client';

import { useChat } from '@ai-sdk/react';
import { DefaultChatTransport } from 'ai';
import { useEffect, useRef, useState } from 'react';
import { Message } from './message';
import { ExampleChips } from './example-chips';
import { LANGS, STRINGS, detectLang, type Lang } from '@/lib/i18n';

export function Chat({ imprintUrl }: { imprintUrl?: string | null }) {
  const [lang, setLang] = useState<Lang>('de');
  const [input, setInput] = useState('');
  const { messages, sendMessage, status, error } = useChat({
    transport: new DefaultChatTransport({ api: '/api/chat' }),
  });

  const endRef = useRef<HTMLDivElement>(null);
  const busy = status === 'submitted' || status === 'streaming';
  const s = STRINGS[lang];

  // Sprache aus dem Browser übernehmen (erst nach Mount → keine Hydration-Mismatches).
  useEffect(() => {
    setLang(detectLang());
  }, []);

  // Nach neuer Nachricht / während des Streamens ans Ende scrollen. scrollIntoView
  // bewegt den tatsächlichen Scroll-Container (inner Div ODER die Seite/Mobile).
  useEffect(() => {
    endRef.current?.scrollIntoView({ behavior: 'smooth', block: 'end' });
  }, [messages, status]);

  function submit(text: string) {
    const trimmed = text.trim();
    if (!trimmed || busy) return;
    sendMessage({ text: trimmed }, { body: { lang } });
    setInput('');
  }

  const empty = messages.length === 0;

  return (
    <div className="flex min-h-dvh flex-col bg-[var(--bg)]">
      {/* Kopfzeile im SBB-Mobile-Stil: roter App-Header, weisse Schrift */}
      <header className="sticky top-0 z-10 bg-[var(--zuegli-red)] shadow-md">
        <div className="mx-auto flex max-w-3xl items-center gap-3 px-4 py-3">
          <span className="zuegli-logo text-lg">Z</span>
          <div className="min-w-0 flex-1">
            <h1 className="truncate text-[17px] font-bold text-white">Zügli</h1>
            <p className="truncate text-xs text-white/85">{s.tagline}</p>
          </div>
          <a
            href="/karte"
            className="shrink-0 rounded-md border border-white/40 px-2.5 py-1.5 text-sm font-semibold text-white hover:bg-white/10"
          >
            🗺️ {s.map}
          </a>
          <span className="hidden shrink-0 rounded-full bg-white/15 px-2.5 py-1 text-[11px] font-semibold text-white sm:inline">
            🌍 {s.langBadge}
          </span>
          <select
            aria-label="Sprache / Language"
            value={lang}
            onChange={(e) => setLang(e.target.value as Lang)}
            className="shrink-0 rounded-md border border-white/40 bg-white px-2 py-1.5 text-sm text-[var(--ink)] focus:border-white focus:outline-none"
          >
            {LANGS.map((l) => (
              <option key={l.code} value={l.code}>
                {l.label}
              </option>
            ))}
          </select>
        </div>
      </header>

      {/* Nachrichten */}
      <main className="mx-auto w-full max-w-3xl flex-1 px-4">
        <div className="h-full space-y-3 overflow-y-auto py-5">
          {empty ? (
            <div className="pt-6">
              <p className="mx-auto max-w-lg text-center text-[var(--muted)]">{s.emptyHint}</p>
              <ExampleChips lang={lang} onPick={submit} />
            </div>
          ) : (
            messages.map((m) => <Message key={m.id} message={m} lang={lang} />)
          )}

          {status === 'submitted' && (
            <div className="flex justify-start">
              <div className="rounded-lg rounded-bl-sm border border-[var(--border)] bg-white px-4 py-3 text-sm text-[var(--muted)]">
                <span className="cursor-blink">{s.thinking}</span>
              </div>
            </div>
          )}

          {error && (
            <div className="mx-auto max-w-lg rounded-lg border border-[var(--zuegli-red)]/40 bg-[var(--zuegli-red)]/5 px-4 py-3 text-center text-sm text-[var(--zuegli-red-dark)]">
              {s.error}
            </div>
          )}

          {/* Scroll-Anker: sorgt dafür, dass neue Nachrichten sichtbar werden */}
          <div ref={endRef} className="h-1 scroll-mb-24" />
        </div>
      </main>

      {/* Eingabe */}
      <div className="sticky bottom-0 border-t border-[var(--border)] bg-white">
        <form
          onSubmit={(e) => {
            e.preventDefault();
            submit(input);
          }}
          className="mx-auto max-w-3xl px-4 pb-4 pt-3"
        >
          <div className="flex items-end gap-2 rounded-lg border border-[var(--border)] bg-white p-1.5 focus-within:border-[var(--zuegli-red)]">
            <textarea
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && !e.shiftKey) {
                  e.preventDefault();
                  submit(input);
                }
              }}
              rows={2}
              maxLength={1000}
              placeholder={s.placeholder}
              className="max-h-40 min-h-[3rem] flex-1 resize-none bg-transparent px-2 py-1.5 text-[15px] leading-snug text-[var(--ink)] placeholder:text-[var(--muted)]/70 focus:outline-none"
            />
            <button
              type="submit"
              disabled={busy || !input.trim()}
              className="rounded-md bg-[var(--zuegli-red)] px-4 py-2.5 text-sm font-bold text-white transition enabled:hover:bg-[var(--zuegli-red-dark)] disabled:cursor-not-allowed disabled:opacity-40"
            >
              {busy ? '…' : s.send}
            </button>
          </div>
          <p className="mt-2 text-center text-[11px] text-[var(--muted)]">
            {s.disclaimer} · {s.footerNote} ·{' '}
            <a
              href="https://github.com/BrainMode/zuegli"
              className="underline hover:text-[var(--ink)]"
              target="_blank"
              rel="noopener noreferrer"
            >
              {s.oss}
            </a>{' '}
            · {s.by}{' '}
            <a
              href="https://wdc-gmbh.ch"
              className="underline hover:text-[var(--ink)]"
              target="_blank"
              rel="noopener noreferrer"
            >
              WDC
            </a>
          </p>
          {imprintUrl && (
            <p className="mt-1 text-center text-[11px] text-[var(--muted)]">
              <a
                href={imprintUrl}
                className="underline hover:text-[var(--ink)]"
                target="_blank"
                rel="noopener noreferrer"
              >
                {s.imprint}
              </a>{' '}
              ·{' '}
              <a href="/datenschutz" className="underline hover:text-[var(--ink)]">
                {s.privacy}
              </a>
            </p>
          )}
        </form>
      </div>
    </div>
  );
}
