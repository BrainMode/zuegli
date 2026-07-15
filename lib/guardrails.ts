// Input-Moderation über die Mistral Moderation API.
// Blockt Jailbreak-Versuche und klar schädliche Inhalte, BEVOR ein (teurerer)
// Chat-Completion-Call passiert. Fail-open: Wenn die Moderation-API selbst
// ausfällt, lassen wir die Anfrage durch (Demo-Verfügbarkeit > Perfektion) und
// loggen eine Warnung.

const MODERATION_MODEL = 'mistral-moderation-2603';
const MODERATION_URL = 'https://api.mistral.ai/v1/moderations';

// Schädliche Kategorien. Bewusst NICHT dabei: pii, health, financial, law —
// die lösen bei harmlosen Reisefragen zu leicht Fehlalarme aus (z.B. „Zug zum
// Krankenhaus", „ich wohne in …").
const HARM_CATEGORIES = [
  'hate_and_discrimination',
  'violence_and_threats',
  'dangerous',
  'criminal',
  'selfharm',
  'sexual',
] as const;

// jailbreaking prüfen wir nur beim INPUT (im Output ergibt es keinen Sinn).
const INPUT_CATEGORIES = ['jailbreaking', ...HARM_CATEGORIES] as const;

// Zusätzlicher Score-Schwellwert, falls das boolean-Flag knapp danebenliegt.
const SCORE_THRESHOLD = 0.7;

export type ModerationResult = { blocked: boolean; reason?: string };

/** Kern-Check gegen die Mistral Moderation API. Fail-open bei API-Fehler. */
async function moderate(text: string, categories: readonly string[]): Promise<ModerationResult> {
  const apiKey = process.env.MISTRAL_API_KEY;
  if (!apiKey || !text.trim()) return { blocked: false };

  try {
    const res = await fetch(MODERATION_URL, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ model: MODERATION_MODEL, input: [text] }),
      signal: AbortSignal.timeout(4000),
    });

    if (!res.ok) {
      console.warn('[guardrails] Moderation-API HTTP', res.status, '→ fail-open');
      return { blocked: false };
    }

    const data = (await res.json()) as {
      results?: Array<{
        categories?: Record<string, boolean>;
        category_scores?: Record<string, number>;
      }>;
    };
    const result = data.results?.[0];
    if (!result) return { blocked: false };

    for (const cat of categories) {
      const flagged = result.categories?.[cat] === true;
      const score = result.category_scores?.[cat] ?? 0;
      if (flagged || score >= SCORE_THRESHOLD) {
        return { blocked: true, reason: cat };
      }
    }
    return { blocked: false };
  } catch (err) {
    console.warn('[guardrails] Moderation-Fehler → fail-open:', err instanceof Error ? err.message : err);
    return { blocked: false };
  }
}

/** Input-Moderation (vor dem LLM-Call): blockt Jailbreaks + schädliche Inhalte. */
export function moderateInput(text: string): Promise<ModerationResult> {
  return moderate(text, INPUT_CATEGORIES);
}

/** Output-Moderation (Post-Inference-Schicht): prüft die erzeugte Antwort auf
 *  schädliche Inhalte. Beim Streaming ist das Detection + Telemetrie (die Antwort
 *  ist beim Aufruf schon ausgeliefert), kein Real-Time-Blocking — für unser
 *  read-only Low-Risk-Thema die passende Best-Practice-Schicht. */
export function moderateOutput(text: string): Promise<ModerationResult> {
  return moderate(text, HARM_CATEGORIES);
}
