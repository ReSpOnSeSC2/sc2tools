import { Fragment, type ReactNode } from "react";

type FencedCode = { text: string; closed: boolean };

function* markdownLines(text: string): Generator<string | FencedCode> {
  let code: { indent: string; lines: string[] } | null = null;
  for (const line of text.slice(0, 30000).split(/\r?\n/)) {
    if (code) {
      if (/^[ \t]*```\s*$/.test(line)) {
        yield { text: code.lines.join("\n"), closed: true };
        code = null;
      } else {
        code.lines.push(line.startsWith(code.indent) ? line.slice(code.indent.length) : line);
      }
      continue;
    }
    const fence = /^([ \t]*)```/.exec(line);
    if (fence) code = { indent: fence[1], lines: [] };
    else yield line;
  }
  if (code) yield { text: code.lines.join("\n"), closed: false };
}

/** Small text-only subset for release notes: paragraphs, headings, lists, code,
 * emphasis and safe links. Raw HTML and images remain escaped text. */
export function MiniMarkdown({ text, className = "" }: { text: string; className?: string }) {
  const blocks: ReactNode[] = [];
  let paragraph: string[] = [];
  let list: string[] = [];
  function flushParagraph() {
    if (paragraph.length) { blocks.push(<p key={blocks.length}>{inline(paragraph.join(" "))}</p>); paragraph = []; }
  }
  function flushList() {
    if (list.length) { blocks.push(<ul key={blocks.length} className="list-disc space-y-1 pl-5">{list.map((item, i) => <li key={i}>{inline(item)}</li>)}</ul>); list = []; }
  }
  function flush() {
    flushParagraph();
    flushList();
  }

  for (const line of markdownLines(text)) {
    if (typeof line !== "string") {
      flush();
      const style = line.closed
        ? "overflow-auto whitespace-pre-wrap break-words rounded border border-border bg-bg-elevated p-2"
        : "whitespace-pre-wrap break-words";
      blocks.push(<pre key={blocks.length} className={style}><code>{line.text}</code></pre>);
      continue;
    }
    const heading = /^#{1,6}\s+(.+)$/.exec(line);
    const bullet = /^\s*(?:[-*]|\d+\.)\s+(.+)$/.exec(line);
    if (heading) { flush(); blocks.push(<p key={blocks.length} className="font-semibold text-text">{inline(heading[1])}</p>); }
    else if (bullet) { flushParagraph(); list.push(bullet[1]); }
    else if (!line.trim()) flush();
    else if (list.length && /^\s/.test(line)) list[list.length - 1] += ` ${line.trim()}`;
    else { flushList(); paragraph.push(line); }
  }
  flush();
  return <div className={`space-y-3 break-words text-caption text-text-muted ${className}`}>{blocks}</div>;
}

function inline(text: string): ReactNode[] {
  const tokens = /(`[^`]+`|\*\*[^*]+\*\*|\*[^*]+\*|(?<!!)\[[^\]]+\]\([^\s)]+\))/g;
  return text.split(tokens).map((part, i) => {
    if (part.startsWith("`")) return <code key={i} className="rounded bg-bg-elevated px-1 font-mono">{part.slice(1, -1)}</code>;
    if (part.startsWith("**")) return <strong key={i}>{part.slice(2, -2)}</strong>;
    if (part.startsWith("*")) return <em key={i}>{part.slice(1, -1)}</em>;
    const link = /^\[([^\]]+)\]\(([^\s)]+)\)$/.exec(part);
    if (link && safeMarkdownHref(link[2])) return <a key={i} href={link[2]} className="rounded text-accent-cyan underline focus-visible:ring-2 focus-visible:ring-accent" rel="noopener noreferrer" target={link[2].startsWith("https:") ? "_blank" : undefined}>{link[1]}</a>;
    return <Fragment key={i}>{part}</Fragment>;
  });
}
export function safeMarkdownHref(href: string): boolean {
  if (/[\u0000-\u0020\u007f\\]/.test(href)) return false;
  if (href.startsWith("/") && !href.startsWith("//")) return true;
  try { const url = new URL(href); return url.protocol === "https:" && !url.username && !url.password; } catch { return false; }
}
