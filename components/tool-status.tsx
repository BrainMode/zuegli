import type { Lang } from '@/lib/i18n';
import { STRINGS } from '@/lib/i18n';

const ICONS: Record<string, string> = {
  searchStations: '🔎',
  getDepartures: '🚉',
  getArrivals: '🚉',
  planJourney: '🗺️',
  trackTrain: '📍',
  nearbyStations: '📍',
  stationFacilities: '🏢',
  facilityStatus: '🛗',
};

export function ToolStatus({
  toolName,
  state,
  lang,
}: {
  toolName: string;
  state: string;
  lang: Lang;
}) {
  const labels = STRINGS[lang].tools[toolName];
  if (!labels) return null;
  const [running, done] = labels;
  const isDone = state === 'output-available';
  const isError = state === 'output-error';

  return (
    <div className="my-1 flex items-center gap-2 text-[13px] text-[var(--muted)]">
      <span aria-hidden>{ICONS[toolName] ?? '•'}</span>
      {isError ? (
        <span className="text-[var(--zuegli-red)]">⚠︎</span>
      ) : isDone ? (
        <span>✓ {done}</span>
      ) : (
        <span className="flex items-center gap-2">
          {running}
          <span className="inline-flex gap-0.5">
            <Dot delay="0ms" />
            <Dot delay="150ms" />
            <Dot delay="300ms" />
          </span>
        </span>
      )}
    </div>
  );
}

function Dot({ delay }: { delay: string }) {
  return (
    <span
      className="inline-block h-1 w-1 animate-bounce rounded-full bg-[var(--zuegli-red)]"
      style={{ animationDelay: delay }}
    />
  );
}
