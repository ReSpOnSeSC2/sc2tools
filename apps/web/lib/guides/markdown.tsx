/**
 * Guide markdown — a deliberately tiny, SAFE markdown subset for the
 * coach's notes on build guides (public pages + the admin live preview).
 *
 * Supported: paragraphs (blank-line separated; soft line breaks join
 * with a space), headings ("### Title" — "#"/"##" are accepted too and
 * all render as <h3>, because notes sit under the page's own <h2>
 * sections), "- " bullet lists, **bold**, *italic*, `code` and
 * [text](https://…) links (http/https only, rel="nofollow noopener").
 *
 * Safety: output is React elements built from plain strings, so React
 * escapes everything; there is no dangerouslySetInnerHTML. Raw HTML,
 * entities ("&lt;") and anything outside the subset render as inert
 * literal text, and a link whose target is not an absolute http(s) URL
 * (javascript:, data:, relative, protocol-relative) renders as its raw
 * source text instead of an <a>.
 *
 * Pure and hook-free, so it works in server components and client
 * islands alike. Class names are spelled with utilities that also occur
 * under app/ and components/ (Tailwind does not scan lib/); callers may
 * override them via `classes`.
 */
import type { ReactNode } from "react";

/** Mirror of the API's GUIDE_NOTE_MAX_CHARS; longer input is truncated. */
export const GUIDE_MARKDOWN_MAX_CHARS = 4000;
/** Nesting cap for inline emphasis inside emphasis/links. */
const MAX_INLINE_DEPTH = 4;
const SAFE_PROTOCOLS: ReadonlySet<string> = new Set(["http:", "https:"]);
const LINK_REL = "nofollow noopener";
const HEADING_RE = /^#{1,3}\s+(.+)$/;
const LIST_ITEM_RE = /^\s*-\s+(.+)$/;
/**
 * Leftmost inline token; alternatives are tried in order at each
 * position: `code` (1), **bold** (2), [text](url) (3, 4), *italic* (5).
 * Emphasis must hug its text ("2 * 3 * 4" stays literal).
 */
const INLINE_RE =
  /`([^`]+)`|\*\*([^\s*](?:.*?[^\s])?)\*\*|\[([^\]]+)\]\(([^()\s]+)\)|\*([^\s*](?:[^*]*[^\s*])?)\*/;

export interface GuideMarkdownClasses {
  root?: string;
  paragraph?: string;
  heading?: string;
  list?: string;
  listItem?: string;
  code?: string;
  link?: string;
}

const DEFAULT_CLASSES: Required<GuideMarkdownClasses> = {
  root: "space-y-3",
  paragraph: "text-body text-text",
  heading: "font-display text-h4 font-bold text-text",
  list: "list-disc space-y-1 pl-5 text-body text-text",
  listItem: "",
  code: "rounded bg-bg-elevated px-1 font-mono text-caption",
  link: "font-semibold text-accent-cyan underline-offset-2 hover:underline",
};

/** One parsed block of the subset. */
export type GuideMarkdownBlock =
  | { kind: "paragraph"; text: string }
  | { kind: "heading"; text: string }
  | { kind: "list"; items: string[] };

/**
 * Absolute http(s) URL, normalised, or null for anything else.
 *
 * Example: `safeGuideHref("https://liquipedia.net/starcraft2")` →
 * "https://liquipedia.net/starcraft2"; `safeGuideHref("javascript:alert(1)")` → null.
 */
export function safeGuideHref(raw: string): string | null {
  try {
    const url = new URL(raw);
    return SAFE_PROTOCOLS.has(url.protocol) ? url.href : null;
  } catch {
    return null;
  }
}

interface BlockBuilder {
  blocks: GuideMarkdownBlock[];
  paragraph: string[];
  list: string[];
}

function flush(state: BlockBuilder): void {
  if (state.paragraph.length) {
    state.blocks.push({ kind: "paragraph", text: state.paragraph.join(" ") });
    state.paragraph = [];
  }
  if (state.list.length) {
    state.blocks.push({ kind: "list", items: state.list });
    state.list = [];
  }
}

function addLine(state: BlockBuilder, rawLine: string): void {
  const text = rawLine.trim();
  if (!text) {
    flush(state);
    return;
  }
  const heading = HEADING_RE.exec(text);
  if (heading) {
    flush(state);
    state.blocks.push({ kind: "heading", text: heading[1].trim() });
    return;
  }
  const item = LIST_ITEM_RE.exec(rawLine);
  if (item) {
    if (state.paragraph.length) flush(state);
    state.list.push(item[1].trim());
    return;
  }
  if (state.list.length) flush(state);
  state.paragraph.push(text);
}

/**
 * Split source into blocks (exported for tests and the admin preview).
 *
 * Example: `parseGuideMarkdown("### Plan\n- Scout\n- Wall")` →
 * `[{ kind: "heading", text: "Plan" }, { kind: "list", items: ["Scout", "Wall"] }]`.
 */
export function parseGuideMarkdown(source: string): GuideMarkdownBlock[] {
  const state: BlockBuilder = { blocks: [], paragraph: [], list: [] };
  const text = typeof source === "string" ? source.slice(0, GUIDE_MARKDOWN_MAX_CHARS) : "";
  for (const rawLine of text.replace(/\r\n?/g, "\n").split("\n")) {
    addLine(state, rawLine);
  }
  flush(state);
  return state.blocks;
}

function renderToken(
  match: RegExpExecArray,
  depth: number,
  key: string,
  classes: Required<GuideMarkdownClasses>,
): ReactNode {
  const [source, code, bold, linkText, linkHref, italic] = match;
  const nested = (text: string): ReactNode =>
    depth < MAX_INLINE_DEPTH ? renderInline(text, depth + 1, key, classes) : text;
  if (code !== undefined) {
    return <code key={key} className={classes.code}>{code}</code>;
  }
  if (bold !== undefined) return <strong key={key}>{nested(bold)}</strong>;
  if (italic !== undefined) return <em key={key}>{nested(italic)}</em>;
  const href = safeGuideHref(linkHref ?? "");
  if (!href) return source;
  return (
    <a key={key} href={href} rel={LINK_REL} target="_blank" className={classes.link}>
      {nested(linkText ?? "")}
    </a>
  );
}

function renderInline(
  text: string,
  depth: number,
  keyPrefix: string,
  classes: Required<GuideMarkdownClasses>,
): ReactNode[] {
  const out: ReactNode[] = [];
  let rest = text;
  let index = 0;
  while (rest) {
    const match = INLINE_RE.exec(rest);
    if (!match) {
      out.push(rest);
      break;
    }
    if (match.index > 0) out.push(rest.slice(0, match.index));
    out.push(renderToken(match, depth, `${keyPrefix}.${index}`, classes));
    rest = rest.slice(match.index + match[0].length);
    index += 1;
  }
  return out;
}

function renderBlock(
  block: GuideMarkdownBlock,
  key: string,
  classes: Required<GuideMarkdownClasses>,
): ReactNode {
  if (block.kind === "heading") {
    return <h3 key={key} className={classes.heading}>{renderInline(block.text, 0, key, classes)}</h3>;
  }
  if (block.kind === "list") {
    return (
      <ul key={key} className={classes.list}>
        {block.items.map((item, i) => (
          <li key={`${key}.${i}`} className={classes.listItem || undefined}>
            {renderInline(item, 0, `${key}.${i}`, classes)}
          </li>
        ))}
      </ul>
    );
  }
  return <p key={key} className={classes.paragraph}>{renderInline(block.text, 0, key, classes)}</p>;
}

/**
 * Render guide markdown to React nodes (one node per block).
 *
 * Example: `renderGuideMarkdown("Chrono the **first Zealot**.")` →
 * `[<p>Chrono the <strong>first Zealot</strong>.</p>]`.
 */
export function renderGuideMarkdown(
  source: string,
  classes: GuideMarkdownClasses = {},
): ReactNode[] {
  const merged: Required<GuideMarkdownClasses> = { ...DEFAULT_CLASSES, ...classes };
  return parseGuideMarkdown(source).map((block, i) => renderBlock(block, `b${i}`, merged));
}

export interface GuideMarkdownProps {
  source: string;
  classes?: GuideMarkdownClasses;
  className?: string;
}

/**
 * Block container for rendered notes; renders nothing for empty input.
 *
 * Example: `<GuideMarkdown source={notes.body} />`.
 */
export function GuideMarkdown({ source, classes, className }: GuideMarkdownProps) {
  const nodes = renderGuideMarkdown(source, classes);
  if (nodes.length === 0) return null;
  return <div className={className ?? classes?.root ?? DEFAULT_CLASSES.root}>{nodes}</div>;
}
