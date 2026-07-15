import { mistral } from '@ai-sdk/mistral';
import {
  streamText,
  convertToModelMessages,
  stepCountIs,
  createUIMessageStream,
  createUIMessageStreamResponse,
  type UIMessage,
} from 'ai';
import { bahnTools } from '@/lib/tools';
import { systemPrompt } from '@/lib/prompts';
import { moderateInput, moderateOutput } from '@/lib/guardrails';
import { checkLimits, trackTokens, clientIp } from '@/lib/ratelimit';

// Node-Runtime (XML-Parsing + node:crypto im Datenlayer).
export const runtime = 'nodejs';
export const maxDuration = 60;

const MODEL = process.env.MISTRAL_MODEL ?? 'mistral-small-latest';
const MAX_MESSAGE_CHARS = 1000;
const MAX_HISTORY = 20;

function json(body: unknown, status: number) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

/**
 * Liefert eine feste Assistenten-Nachricht als UI-Message-Stream zurück, sodass
 * sie im Chat als normale Antwort-Bubble erscheint (statt als Fehler-Banner).
 * Wird für Guardrail-/Limit-Fälle genutzt — ohne LLM-Call, also ohne Kosten.
 */
function cannedMessage(text: string) {
  const stream = createUIMessageStream({
    execute: async ({ writer }) => {
      writer.write({ type: 'text-start', id: '0' });
      writer.write({ type: 'text-delta', id: '0', delta: text });
      writer.write({ type: 'text-end', id: '0' });
    },
  });
  return createUIMessageStreamResponse({ stream });
}

/** Extrahiert den reinen Text-Inhalt der letzten User-Nachricht. */
function lastUserText(messages: UIMessage[]): string {
  const last = [...messages].reverse().find((m) => m.role === 'user');
  if (!last || !Array.isArray(last.parts)) return '';
  return last.parts
    .filter((p) => p.type === 'text')
    .map((p) => (p as { text: string }).text)
    .join(' ')
    .trim();
}

export async function POST(req: Request) {
  // 1) Statische Validierung (0 Kosten)
  let messages: UIMessage[];
  let uiLang: string | undefined;
  try {
    const body = await req.json();
    messages = body.messages;
    uiLang = typeof body.lang === 'string' ? body.lang : undefined;
    if (!Array.isArray(messages) || messages.length === 0) throw new Error('messages fehlt');
  } catch {
    return json({ error: 'invalid', message: 'Ungültige Anfrage.' }, 400);
  }

  const userText = lastUserText(messages);
  if (userText.length > MAX_MESSAGE_CHARS) {
    return json(
      { error: 'too_long', message: 'Deine Nachricht ist zu lang. Bitte fasse dich kürzer.' },
      400,
    );
  }
  // History serverseitig begrenzen (Kosten- und Missbrauchsschutz).
  const trimmed = messages.slice(-MAX_HISTORY);

  // 2) Rate-Limiting VOR jedem Spend
  const verdict = await checkLimits(clientIp(req));
  if (!verdict.ok) {
    if (verdict.kind === 'budget') {
      return cannedMessage(
        'Das Tagesbudget dieser kostenlosen Demo ist gerade aufgebraucht — morgen geht es weiter. 🚆\n\n' +
          'Du willst nicht warten? Fork das Repo und nutze deinen eigenen (europäischen) Mistral-Key ' +
          '— das dauert 2 Minuten: github.com/BrainMode/zuegli',
      );
    }
    return cannedMessage(
      'Etwas zu schnell 🚦 — bitte warte einen kurzen Moment und frag dann noch einmal.',
    );
  }

  // 3) Input-Moderation (1 günstiger Call; blockt Jailbreaks & schädliche Inhalte)
  if (userText) {
    const mod = await moderateInput(userText);
    if (mod.blocked) {
      return cannedMessage(
        'Dazu kann ich nichts sagen — ich beantworte nur Fragen rund um Zugverbindungen, ' +
          'Verspätungen und Fahrpläne. Frag mich zum Beispiel nach der nächsten Verbindung ' +
          'oder ob dein Zug pünktlich ist. 🚆',
      );
    }
  }

  // 4) LLM-Loop mit harten Grenzen
  // convertToModelMessages wirft bei strukturell kaputten Messages (z.B. ohne
  // parts, unbekannte role) — das ist eine ungültige Anfrage, kein 500er.
  let modelMessages;
  try {
    modelMessages = await convertToModelMessages(trimmed);
  } catch {
    return json({ error: 'invalid', message: 'Ungültige Anfrage.' }, 400);
  }

  const result = streamText({
    model: mistral(MODEL),
    system: systemPrompt(uiLang),
    messages: modelMessages,
    tools: bahnTools,
    stopWhen: stepCountIs(6),
    temperature: 0.3,
    maxOutputTokens: 800,
    onFinish: async ({ usage, text }) => {
      void trackTokens(usage?.inputTokens ?? 0, usage?.outputTokens ?? 0);
      // Post-Inference-Schicht: erzeugte Antwort gegen die Moderation prüfen.
      // Geflaggte Outputs werden als Telemetrie geloggt (Red-Team-/Audit-Signal).
      if (text) {
        const out = await moderateOutput(text);
        if (out.blocked) {
          console.warn(
            `[guardrail:output-flagged] category=${out.reason} snippet=${JSON.stringify(text.slice(0, 200))}`,
          );
        }
      }
    },
  });

  return result.toUIMessageStreamResponse();
}
