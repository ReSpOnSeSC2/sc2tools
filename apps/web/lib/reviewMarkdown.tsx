import type { ReactNode } from "react";

/**
 * Safe markdown subset for review comments.
 *
 * The text is parsed into React ELEMENTS — never HTML strings, never
 * ``dangerouslySetInnerHTML`` — so raw HTML in a comment can only ever
 * render as literal text. Supported:
 *
 *   paragraphs (blank line) and line breaks, "- " / "* " bullet lists,
 *   "1. " numbered lists, "> " quotes, `code`, **bold**, *italic* /
 *   _italic_, [label](https://…) and bare https:// links (rel="nofollow
 *   ugc noopener noreferrer"), and game-clock timestamps ("5:12",
 *   "1:05:12") which become seek chips when ``onSeek`` is given.
 *
 * Only http(s) URLs ever become links; ``javascript:``, ``data:`` and
 * friends stay plain text.
 */

export type MarkdownOptions = {
  onSeek?: (seconds: number) => void;
  /** Game length, so "99:99"-style non-times never become chips. */
  maxSeconds?: number | null;
};

const LINK_REL = "nofollow ugc noopener noreferrer";

export function safeHttpUrl(raw: string): string | null {
  const value = raw.trim();
  if (!/^https?:\/\//i.test(value)) return null;
  try {
    const url = new URL(value);
    if (url.protocol !== "https:" && url.protocol !== "http:") return null;
    return url.toString();
  } catch {
    return null;
  }
}

type Block =
  | { kind: "p"; lines: string[] }
  | { kind: "ul"; items: string[] }
  | { kind: "ol"; items: string[] }
  | { kind: "quote"; lines: string[] };

export function parseBlocks(text: string): Block[] {
  const blocks: Block[] = [];
  const lines = text.replace(/\r\n?/g, "\n").split("\n");
  for (const raw of lines) {
    const line = raw.trimEnd();
    const last: Block | undefined = blocks[blocks.length - 1];
    if (!line.trim()) {
      // A blank line ends the current block; the next line starts fresh.
      if (last && !(last.kind === "p" && last.lines.length === 0)) blocks.push({ kind: "p", lines: [] });
      continue;
    }
    const bullet = /^\s*[-*]\s+(.*)$/.exec(line);
    const numbered = /^\s*\d{1,3}[.)]\s+(.*)$/.exec(line);
    const quote = /^\s*>\s?(.*)$/.exec(line);
    if (bullet) {
      if (last?.kind === "ul") last.items.push(bullet[1]);
      else blocks.push({ kind: "ul", items: [bullet[1]] });
    } else if (numbered) {
      if (last?.kind === "ol") last.items.push(numbered[1]);
      else blocks.push({ kind: "ol", items: [numbered[1]] });
    } else if (quote) {
      if (last?.kind === "quote") last.lines.push(quote[1]);
      else blocks.push({ kind: "quote", lines: [quote[1]] });
    } else if (last?.kind === "p") {
      last.lines.push(line);
    } else {
      blocks.push({ kind: "p", lines: [line] });
    }
  }
  // Drop the empty separator paragraphs.
  return blocks.filter((b) => !(b.kind === "p" && b.lines.length === 0));
}

// Order matters: code first (its content is literal), then links, then
// emphasis, then bare URLs and timestamps.
// Source only: every renderInline call builds its OWN global regex.
// Emphasis and link labels recurse, and a shared ``lastIndex`` would
// make the outer scan restart from 0 forever.
const INLINE_SOURCE = (
  [
    "`([^`\\n]{1,200})`", // 1 code
    "\\[([^\\]\\n]{1,200})\\]\\(([^)\\s]{1,2000})\\)", // 2 label, 3 url
    "\\*\\*([^*\\n]{1,500})\\*\\*", // 4 bold
    "(?<![\\w*])\\*([^*\\n]{1,500})\\*(?![\\w*])", // 5 italic *
    "(?<![\\w_])_([^_\\n]{1,500})_(?![\\w_])", // 6 italic _
    "(https?:\\/\\/[^\\s<>()]{1,2000})", // 7 bare url
    "(?<![\\d:])(\\d{1,2}(?::[0-5]\\d){1,2})(?![\\d:])", // 8 timestamp
  ].join("|")
);

export function renderInline(text: string, opts: MarkdownOptions = {}, keyPrefix = "i"): ReactNode[] {
  const out: ReactNode[] = [];
  let last = 0;
  let n = 0;
  const re = new RegExp(INLINE_SOURCE, "g");
  for (let m = re.exec(text); m; m = re.exec(text)) {
    if (m.index > last) out.push(text.slice(last, m.index));
    const key = `${keyPrefix}-${n++}`;
    if (m[1] !== undefined) {
      out.push(<code key={key} className="rounded bg-bg-elevated px-1 py-0.5 font-mono text-[0.85em]">{m[1]}</code>);
    } else if (m[2] !== undefined) {
      const href = safeHttpUrl(m[3]);
      out.push(href ? externalLink(href, renderInline(m[2], opts, key), key) : m[0]);
    } else if (m[4] !== undefined) {
      out.push(<strong key={key}>{renderInline(m[4], opts, key)}</strong>);
    } else if (m[5] !== undefined || m[6] !== undefined) {
      out.push(<em key={key}>{renderInline(m[5] ?? m[6], opts, key)}</em>);
    } else if (m[7] !== undefined) {
      // Trailing sentence punctuation belongs to the sentence, not the URL.
      const trimmed = m[7].replace(/[.,;:!?]+$/, "");
      const href = safeHttpUrl(trimmed);
      out.push(href ? externalLink(href, trimmed, key) : trimmed);
      if (trimmed.length < m[7].length) out.push(m[7].slice(trimmed.length));
    } else if (m[8] !== undefined) {
      out.push(timestamp(m[8], opts, key));
    }
    last = m.index + m[0].length;
  }
  if (last < text.length) out.push(text.slice(last));
  return out;
}

function externalLink(href: string, children: ReactNode, key: string) {
  return (
    <a key={key} href={href} rel={LINK_REL} target="_blank" className="text-accent-cyan underline underline-offset-2 hover:text-accent">
      {children}
    </a>
  );
}

function timestamp(raw: string, opts: MarkdownOptions, key: string): ReactNode {
  const parts = raw.split(":").map(Number);
  const seconds = parts.reduce((acc, v) => acc * 60 + v, 0);
  const max = opts.maxSeconds;
  if (!opts.onSeek || (typeof max === "number" && seconds > max + 1)) return raw;
  const onSeek = opts.onSeek;
  return (
    <button
      key={key}
      type="button"
      onClick={() => onSeek(seconds)}
      aria-label={`Jump to ${raw}`}
      className="rounded px-0.5 font-mono font-semibold text-accent-cyan underline decoration-dotted underline-offset-2 hover:text-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
    >
      {raw}
    </button>
  );
}

/** Render a comment body as React nodes (the only public entry point). */
export function ReviewMarkdown({ text, onSeek, maxSeconds }: { text: string } & MarkdownOptions) {
  const opts = { onSeek, maxSeconds };
  const blocks = parseBlocks(text);
  return (
    <div className="space-y-2 break-words text-body leading-relaxed text-text">
      {blocks.map((block, index) => {
        const key = `b${index}`;
        if (block.kind === "ul" || block.kind === "ol") {
          const List = block.kind;
          return (
            <List key={key} className={`${block.kind === "ul" ? "list-disc" : "list-decimal"} space-y-1 pl-5`}>
              {block.items.map((item, i) => <li key={`${key}-${i}`}>{renderInline(item, opts, `${key}-${i}`)}</li>)}
            </List>
          );
        }
        if (block.kind === "quote") {
          return (
            <blockquote key={key} className="border-l-2 border-border-strong pl-3 text-text-muted">
              {withBreaks(block.lines, opts, key)}
            </blockquote>
          );
        }
        return <p key={key}>{withBreaks(block.lines, opts, key)}</p>;
      })}
    </div>
  );
}

function withBreaks(lines: string[], opts: MarkdownOptions, key: string): ReactNode[] {
  const out: ReactNode[] = [];
  lines.forEach((line, i) => {
    if (i > 0) out.push(<br key={`${key}-br-${i}`} />);
    out.push(...renderInline(line, opts, `${key}-${i}`));
  });
  return out;
}
