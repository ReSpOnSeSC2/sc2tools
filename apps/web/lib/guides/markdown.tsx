/**
 * Guide markdown — the coach's notes on build guides (public pages + the
 * admin live preview), rendered with the site's one safe inline renderer.
 *
 * This module only adds the BLOCK structure notes need: paragraphs
 * (blank-line separated; soft line breaks join with a space), headings
 * ("### Title" — "#"/"##" are accepted too and all render as <h3>,
 * because notes sit under the page's own <h2> sections), "- " bullet
 * lists and the 4,000-character cap. Everything INLINE — `code`,
 * **bold**, *italic* / _italic_, [text](https://…) and bare https://
 * links — is `renderInline` from lib/reviewMarkdown.tsx, so link safety
 * (`safeHttpUrl`: absolute http(s) only) and the link rel ("nofollow ugc
 * noopener noreferrer") live in one place for reviews and notes alike.
 * No `onSeek` is passed, so game clocks ("4:30") stay plain text.
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
 * override the block classes via `classes`.
 */
import type { ReactNode } from "react";
import { renderInline, safeHttpUrl } from "@/lib/reviewMarkdown";

/** Mirror of the API's GUIDE_NOTE_MAX_CHARS; longer input is truncated. */
export const GUIDE_MARKDOWN_MAX_CHARS = 4000;
const HEADING_RE = /^#{1,3}\s+(.+)$/;
const LIST_ITEM_RE = /^\s*-\s+(.+)$/;

export interface GuideMarkdownClasses {
  root?: string;
  paragraph?: string;
  heading?: string;
  list?: string;
  listItem?: string;
}

const DEFAULT_CLASSES: Required<GuideMarkdownClasses> = {
  root: "space-y-3",
  paragraph: "text-body text-text",
  heading: "font-display text-h4 font-bold text-text",
  list: "list-disc space-y-1 pl-5 text-body text-text",
  listItem: "",
};

/** One parsed block of the subset. */
export type GuideMarkdownBlock =
  | { kind: "paragraph"; text: string }
  | { kind: "heading"; text: string }
  | { kind: "list"; items: string[] };

/**
 * Absolute http(s) URL, normalised, or null for anything else — the
 * review renderer's `safeHttpUrl`, so notes and reviews share one rule.
 *
 * Example: `safeGuideHref("https://liquipedia.net/starcraft2")` →
 * "https://liquipedia.net/starcraft2"; `safeGuideHref("javascript:alert(1)")` → null.
 */
export function safeGuideHref(raw: string): string | null {
  return safeHttpUrl(raw);
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

function renderBlock(
  block: GuideMarkdownBlock,
  key: string,
  classes: Required<GuideMarkdownClasses>,
): ReactNode {
  if (block.kind === "heading") {
    return <h3 key={key} className={classes.heading}>{renderInline(block.text, {}, key)}</h3>;
  }
  if (block.kind === "list") {
    return (
      <ul key={key} className={classes.list}>
        {block.items.map((item, i) => (
          <li key={`${key}.${i}`} className={classes.listItem || undefined}>
            {renderInline(item, {}, `${key}.${i}`)}
          </li>
        ))}
      </ul>
    );
  }
  return <p key={key} className={classes.paragraph}>{renderInline(block.text, {}, key)}</p>;
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
