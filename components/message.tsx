import type { UIMessage } from 'ai';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import type { Lang } from '@/lib/i18n';
import { ToolStatus } from './tool-status';
import RouteMapLazy from './route-map-lazy';
import type { RouteStop } from './route-map';

// Extrahiert aus einem Tool-Output die Route für die Inline-Karte.
// trackTrain: stops[] mit lon/lat; planJourney: Leg-Grenzen der 1. Verbindung.
function routeFromToolOutput(
  toolName: string,
  output: unknown,
): { stops: RouteStop[]; journeyRef: string | null } | null {
  if (!output || typeof output !== 'object' || 'error' in (output as object)) return null;
  const o = output as Record<string, any>;
  if (toolName === 'trackTrain' && Array.isArray(o.stops)) {
    const stops: RouteStop[] = o.stops
      .filter((s: any) => typeof s?.lon === 'number' && typeof s?.lat === 'number')
      .map((s: any) => ({ name: s.name, lon: s.lon, lat: s.lat, cancelled: s.cancelled }));
    if (stops.length < 2) return null;
    return { stops, journeyRef: typeof o.journeyRef === 'string' ? o.journeyRef : null };
  }
  if (toolName === 'planJourney' && Array.isArray(o.journeys) && o.journeys[0]?.legs) {
    const stops: RouteStop[] = [];
    for (const leg of o.journeys[0].legs as Array<Record<string, any>>) {
      if (Array.isArray(leg.fromPos)) stops.push({ name: leg.from, lon: leg.fromPos[0], lat: leg.fromPos[1] });
      if (Array.isArray(leg.toPos)) stops.push({ name: leg.to, lon: leg.toPos[0], lat: leg.toPos[1] });
    }
    // Doppelte Umsteige-Punkte (to von Leg n == from von Leg n+1) ausdünnen.
    const dedup = stops.filter((s, i) => i === 0 || s.name !== stops[i - 1].name);
    if (dedup.length < 2) return null;
    const firstTripId = (o.journeys[0].legs as Array<Record<string, any>>).find((l) => l.tripId)?.tripId;
    const journeyRef = typeof firstTripId === 'string' ? firstTripId.split('~')[0] : null;
    return { stops: dedup, journeyRef };
  }
  return null;
}

// Markdown-Styling für Assistenten-Antworten (fett, Listen, Links) im DB-Look.
const MD_COMPONENTS = {
  p: (props: React.HTMLAttributes<HTMLParagraphElement>) => (
    <p className="[&:not(:first-child)]:mt-2" {...props} />
  ),
  strong: (props: React.HTMLAttributes<HTMLElement>) => (
    <strong className="font-bold text-[var(--ink)]" {...props} />
  ),
  ul: (props: React.HTMLAttributes<HTMLUListElement>) => (
    <ul className="my-1.5 ml-4 list-disc space-y-0.5" {...props} />
  ),
  ol: (props: React.HTMLAttributes<HTMLOListElement>) => (
    <ol className="my-1.5 ml-4 list-decimal space-y-0.5" {...props} />
  ),
  li: (props: React.HTMLAttributes<HTMLLIElement>) => <li className="pl-0.5" {...props} />,
  hr: () => <hr className="my-2.5 border-[var(--border)]" />,
  a: (props: React.AnchorHTMLAttributes<HTMLAnchorElement>) => (
    <a className="text-[var(--zuegli-red)] underline" target="_blank" rel="noopener noreferrer" {...props} />
  ),
  h1: (props: React.HTMLAttributes<HTMLHeadingElement>) => (
    <p className="mt-2 font-bold text-[var(--ink)]" {...props} />
  ),
  h2: (props: React.HTMLAttributes<HTMLHeadingElement>) => (
    <p className="mt-2 font-bold text-[var(--ink)]" {...props} />
  ),
  h3: (props: React.HTMLAttributes<HTMLHeadingElement>) => (
    <p className="mt-2 font-bold text-[var(--ink)]" {...props} />
  ),
  code: (props: React.HTMLAttributes<HTMLElement>) => (
    <code className="rounded bg-[var(--panel)] px-1 py-0.5 font-mono text-[13px]" {...props} />
  ),
};

// Rendert eine Chat-Nachricht aus ihren typisierten Parts (DB-Look).
export function Message({ message, lang }: { message: UIMessage; lang: Lang }) {
  const isUser = message.role === 'user';

  return (
    <div className={`animate-in flex ${isUser ? 'justify-end' : 'justify-start'}`}>
      <div
        className={
          isUser
            ? 'max-w-[85%] rounded-lg rounded-br-sm bg-[var(--zuegli-red)] px-4 py-2.5 text-[15px] leading-relaxed text-white'
            : 'max-w-[92%] rounded-lg rounded-bl-sm border border-[var(--border)] bg-white px-4 py-3 text-[15px] leading-relaxed text-[var(--ink)]'
        }
      >
        {message.parts.map((part, i) => {
          if (part.type === 'text') {
            return isUser ? (
              <p key={i} className="whitespace-pre-wrap">
                {part.text}
              </p>
            ) : (
              <ReactMarkdown key={i} remarkPlugins={[remarkGfm]} components={MD_COMPONENTS}>
                {part.text}
              </ReactMarkdown>
            );
          }
          if (part.type.startsWith('tool-')) {
            const toolName = part.type.slice('tool-'.length);
            const state = (part as { state?: string }).state ?? '';
            const route =
              state === 'output-available'
                ? routeFromToolOutput(toolName, (part as { output?: unknown }).output)
                : null;
            return (
              <div key={i}>
                <ToolStatus toolName={toolName} state={state} lang={lang} />
                {route && <RouteMapLazy stops={route.stops} journeyRef={route.journeyRef} />}
              </div>
            );
          }
          return null;
        })}
      </div>
    </div>
  );
}
