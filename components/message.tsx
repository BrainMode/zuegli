import type { UIMessage } from 'ai';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import type { Lang } from '@/lib/i18n';
import { ToolStatus } from './tool-status';

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
            return <ToolStatus key={i} toolName={toolName} state={state} lang={lang} />;
          }
          return null;
        })}
      </div>
    </div>
  );
}
