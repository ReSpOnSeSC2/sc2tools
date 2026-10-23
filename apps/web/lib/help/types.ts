/**
 * Help center content model. Every article is plain data: one file per
 * article under lib/help/articles/<category>/<slug>.ts (default export
 * typed HelpArticle), collected into articles/index.generated.ts by
 * `npm run help:index`. The same articles render on the public /help
 * pages, in Settings → Help and in the <HelpLink> side sheet.
 *
 * Text fields (paragraphs, list and step items, callouts, table cells)
 * accept the small inline markup parsed by lib/help/inline.ts:
 *
 *   **bold**   *italic*   `code`   [label](/path)
 *
 * Link targets are site paths ("/settings?tab=overlay", "/help/<slug>"),
 * https:// URLs or mailto: addresses. Anything else renders as literal
 * text. A backslash escapes a markup character ("\*" is a literal
 * asterisk).
 */

/** Topic an article is filed under; display names and order live in categories.ts. */
export type HelpCategoryId =
  | "getting-started"
  | "desktop-app"
  | "analyzer"
  | "game-page"
  | "opponents"
  | "builds"
  | "stream-studio"
  | "account-data"
  | "troubleshooting";

/** Who the article is written for. "all" shows no audience label. */
export type HelpAudience = "player" | "streamer" | "all";

/** Calendar date the article's content last changed, as YYYY-MM-DD. */
export type HelpDate = `${number}-${number}-${number}`;

export type HelpCalloutTone = "info" | "warning" | "success";

/**
 * Interactive pieces an article can embed. Each id maps to a component
 * in components/help/HelpWidget.tsx and to searchable text in
 * lib/help/widgets.ts.
 */
export type HelpWidgetId = "chat-commands";

export type HelpBlock =
  /** A paragraph of text. */
  | { type: "paragraph"; text: string }
  /**
   * A sub-heading inside the article. `anchor` gives it a stable id on
   * the article page (/help/<slug>#<anchor>) so other parts of the app
   * can link to one section: lowercase letters, digits and hyphens,
   * unique within the article. Keep an anchor once it is published.
   */
  | { type: "heading"; text: string; anchor?: string }
  /** A numbered sequence the reader follows in order. */
  | { type: "steps"; items: string[] }
  /** A bulleted list. */
  | { type: "list"; items: string[] }
  /** A highlighted note. */
  | { type: "callout"; tone: HelpCalloutTone; title?: string; text: string }
  /** A prominent link to a page in the app (settings tab, Stream Studio guide, ...). */
  | { type: "settingsLink"; label: string; href: string }
  /** A screenshot or diagram served from /public. */
  | { type: "image"; src: string; alt: string; caption?: string }
  /** A small reference table. */
  | { type: "table"; head: string[]; rows: string[][] }
  /** An embedded interactive piece (see HelpWidgetId). */
  | { type: "widget"; widget: HelpWidgetId };

export interface HelpArticle {
  /** URL slug: lowercase letters, digits and hyphens; also the file name. */
  slug: string;
  title: string;
  /** One or two plain sentences: shown under the title and as the search snippet. */
  summary: string;
  category: HelpCategoryId;
  audience: HelpAudience;
  /**
   * The article walks through actions that need an account. It still
   * renders for everyone; signed-out readers see a sign-in note.
   */
  signedInOnly?: boolean;
  /** Extra search terms: the words a reader might type that the text doesn't use. */
  keywords: string[];
  updated: HelpDate;
  body: HelpBlock[];
  /** Slugs of other articles shown under "Related articles". */
  related: string[];
  /**
   * Old Settings → Help anchors that should open this article
   * (e.g. a section renamed from "#old-name").
   */
  legacyAnchors?: string[];
  /** Position within its category, lower first (default 100); ties sort by title. */
  order?: number;
}
