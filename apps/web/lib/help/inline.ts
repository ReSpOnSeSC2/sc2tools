/**
 * The help articles' inline markup, parsed into a small node tree that
 * components/help/HelpInline.tsx turns into React elements. No HTML
 * string is ever built and nothing uses dangerouslySetInnerHTML: text
 * stays text, so markup outside this subset renders literally.
 *
 *   **bold**          strong emphasis (button and label names)
 *   *italic*          emphasis (on-screen messages)
 *   `code`            commands and literal values (`!rank`)
 *   [label](href)     a link; the label may use bold, italic and code
 *   \*  \`  \[  \]    a backslash makes the next markup character literal
 *
 * Link targets: site paths ("/settings?tab=help#build-check-in",
 * "/help/<slug>"), https:// URLs and mailto: addresses. Any other target
 * (javascript:, protocol-relative "//host", http://, a bare "#anchor"
 * that would go nowhere on the public page) leaves the whole
 * "[label](href)" as plain text.
 *
 * Pure and dependency-free so the parser, the search index and the
 * JSON-LD builder all read the same structure.
 */

export type HelpHrefKind = "internal" | "external" | "email";

export type HelpInlineNode =
  | { kind: "text"; text: string }
  | { kind: "strong"; children: HelpInlineNode[] }
  | { kind: "em"; children: HelpInlineNode[] }
  | { kind: "code"; text: string }
  | { kind: "link"; href: string; hrefKind: HelpHrefKind; children: HelpInlineNode[] };

// Earliest match wins; at the same position the first alternative wins,
// so an escape beats everything and code beats emphasis.
const INLINE_SOURCE = [
  "\\\\([\\\\`*\\[\\]()])", // 1 escaped character
  "`([^`\\n]+)`", // 2 code
  "\\[((?:[^\\]\\\\\\n]|\\\\.)+)\\]\\(([^)\\s]+)\\)", // 3 label, 4 href
  "\\*\\*((?:[^*\\\\\\n]|\\\\.)+)\\*\\*", // 5 bold
  "(?<![\\w*])\\*((?:[^*\\\\\\n]|\\\\.)+)\\*(?![\\w*])", // 6 italic
].join("|");

const HELP_ARTICLE_PATH_RE = /^\/help\/([a-z0-9-]+)$/;

/**
 * What kind of link a markup target is, or null when it isn't allowed.
 *
 * Example: `helpHrefKind("/devices")` → "internal";
 * `helpHrefKind("javascript:alert(1)")` → null.
 */
export function helpHrefKind(href: string): HelpHrefKind | null {
  if (/^\/(?![/\\])[^\s\\]*$/.test(href)) return "internal";
  if (/^https:\/\/[^\s/\\]+[^\s\\]*$/i.test(href)) return "external";
  if (/^mailto:[^\s@/\\]+@[^\s@/\\]+$/i.test(href)) return "email";
  return null;
}

/**
 * The article slug a link points at, when it is a help article path.
 *
 * Example: `helpArticleSlugFromHref("/help/getting-started")` → "getting-started".
 */
export function helpArticleSlugFromHref(href: string): string | null {
  return HELP_ARTICLE_PATH_RE.exec(href)?.[1] ?? null;
}

function pushText(out: HelpInlineNode[], text: string): void {
  if (!text) return;
  const last = out[out.length - 1];
  if (last?.kind === "text") last.text += text;
  else out.push({ kind: "text", text });
}

function parse(text: string, inLink: boolean): HelpInlineNode[] {
  const out: HelpInlineNode[] = [];
  // A fresh regex per call: labels and emphasis recurse, and a shared
  // lastIndex would restart the outer scan.
  const re = new RegExp(INLINE_SOURCE, "g");
  let last = 0;
  for (let m = re.exec(text); m; m = re.exec(text)) {
    pushText(out, text.slice(last, m.index));
    last = m.index + m[0].length;
    if (m[1] !== undefined) {
      pushText(out, m[1]);
    } else if (m[2] !== undefined) {
      out.push({ kind: "code", text: m[2] });
    } else if (m[3] !== undefined) {
      const hrefKind = inLink ? null : helpHrefKind(m[4]);
      if (hrefKind) {
        out.push({ kind: "link", href: m[4], hrefKind, children: parse(m[3], true) });
      } else {
        pushText(out, m[0]);
      }
    } else if (m[5] !== undefined) {
      out.push({ kind: "strong", children: parse(m[5], inLink) });
    } else if (m[6] !== undefined) {
      out.push({ kind: "em", children: parse(m[6], inLink) });
    }
  }
  pushText(out, text.slice(last));
  return out;
}

/**
 * Parse one text field into inline nodes.
 *
 * Example: `parseHelpInline("Open **Settings**")` →
 * `[{ kind: "text", text: "Open " }, { kind: "strong", children: [{ kind: "text", text: "Settings" }] }]`.
 */
export function parseHelpInline(text: string): HelpInlineNode[] {
  return parse(text, false);
}

function nodesText(nodes: ReadonlyArray<HelpInlineNode>): string {
  return nodes
    .map((node) => (node.kind === "text" || node.kind === "code" ? node.text : nodesText(node.children)))
    .join("");
}

/**
 * The text a reader sees, with the markup removed (search index, meta
 * descriptions, structured data).
 *
 * Example: `helpInlinePlainText("Press **Save** in [Settings](/settings)")` →
 * "Press Save in Settings".
 */
export function helpInlinePlainText(text: string): string {
  return nodesText(parseHelpInline(text));
}

function collectLinks(nodes: ReadonlyArray<HelpInlineNode>, out: string[]): void {
  for (const node of nodes) {
    if (node.kind === "link") out.push(node.href);
    if (node.kind === "strong" || node.kind === "em" || node.kind === "link") collectLinks(node.children, out);
  }
}

/**
 * Every link target in a text field (used by the tests that check each
 * in-app link resolves).
 *
 * Example: `helpInlineLinks("See [Devices](/devices)")` → ["/devices"].
 */
export function helpInlineLinks(text: string): string[] {
  const out: string[] = [];
  collectLinks(parseHelpInline(text), out);
  return out;
}
