import { Fragment, type ReactNode } from "react";

/**
 * A deliberately small Markdown subset for bot answers: fenced code blocks, inline code, bold and
 * paragraphs. Builds React nodes, never HTML strings, so model output cannot inject markup.
 */
export function Markdown({ text }: { text: string }) {
  const blocks = text.split(/(```[\s\S]*?(?:```|$))/g).filter(Boolean);
  return (
    <>
      {blocks.map((block, i) => {
        if (block.startsWith("```")) {
          const body = block.replace(/^```[^\n]*\n?/, "").replace(/```$/, "");
          return (
            // biome-ignore lint/suspicious/noArrayIndexKey: blocks are positional and never reordered
            <pre key={i} className="md-code">
              <code>{body}</code>
            </pre>
          );
        }
        return block
          .split(/\n{2,}/)
          .filter((p) => p.trim())
          .map((para, j) => (
            // biome-ignore lint/suspicious/noArrayIndexKey: paragraphs are positional and never reordered
            <p key={`${i}-${j}`} className="md-p">
              {inline(para)}
            </p>
          ));
      })}
    </>
  );
}

function inline(text: string): ReactNode[] {
  return text.split(/(`[^`\n]+`|\*\*[^*\n]+\*\*)/g).map((part, i) => {
    if (part.startsWith("`") && part.endsWith("`") && part.length > 2) {
      // biome-ignore lint/suspicious/noArrayIndexKey: positional inline parts
      return <code key={i}>{part.slice(1, -1)}</code>;
    }
    if (part.startsWith("**") && part.endsWith("**") && part.length > 4) {
      // biome-ignore lint/suspicious/noArrayIndexKey: positional inline parts
      return <strong key={i}>{part.slice(2, -2)}</strong>;
    }
    // biome-ignore lint/suspicious/noArrayIndexKey: positional inline parts
    return <Fragment key={i}>{part}</Fragment>;
  });
}
