/**
 * Help registry: lookups over every article in
 * articles/index.generated.ts (run `npm run help:index` after adding an
 * article file). Pure and synchronous, so server pages, client islands
 * and tests share it.
 */
import { ALL_HELP_ARTICLES } from "./articles/index.generated";
import { HELP_CATEGORIES, type HelpCategory } from "./categories";
import { POPULAR_HELP_SLUGS } from "./popular";
import type { HelpArticle } from "./types";
import { helpArticlePath } from "./paths";
export { helpArticlePath } from "./paths";

export { ALL_HELP_ARTICLES };

const DEFAULT_ORDER = 100;

const BY_SLUG: ReadonlyMap<string, HelpArticle> = new Map(
  ALL_HELP_ARTICLES.map((article) => [article.slug, article]),
);

/**
 * The article with this slug, if any.
 *
 * Example: `getArticle("getting-started")?.title` → "Getting started (5 minutes)".
 */
export function getArticle(slug: string): HelpArticle | undefined {
  return BY_SLUG.get(slug);
}

/**
 * Public URL of an article, optionally at one of its section anchors.
 *
 * Example: `helpArticlePath("stream-dock")` → "/help/stream-dock";
 * `helpArticlePath("replay-reviews", "who-can-review")` → "/help/replay-reviews#who-can-review".
 */

/**
 * The section anchors an article defines: the `anchor` of each heading
 * block, in reading order.
 *
 * Example: `helpArticleAnchors(getArticle("replay-reviews")!)[0]` → "how-it-works".
 */
export function helpArticleAnchors(article: HelpArticle): string[] {
  return article.body.flatMap((block) => (block.type === "heading" && block.anchor ? [block.anchor] : []));
}

/** In-app URL that opens an article in Settings → Help. */
export function helpSettingsPath(slug: string): string {
  return `/settings?tab=help#${slug}`;
}

/**
 * Public URL of one section of an article (a heading's `anchor`).
 *
 * Example: `helpAnchorPath("opponents", "net-mmr")` → "/help/opponents#net-mmr".
 */
export function helpAnchorPath(slug: string, anchor: string): string {
  return `${helpArticlePath(slug)}#${anchor}`;
}

function compareArticles(a: HelpArticle, b: HelpArticle): number {
  const order = (a.order ?? DEFAULT_ORDER) - (b.order ?? DEFAULT_ORDER);
  if (order !== 0) return order;
  return a.title.localeCompare(b.title, "en") || (a.slug < b.slug ? -1 : a.slug > b.slug ? 1 : 0);
}

export interface HelpCategoryGroup {
  category: HelpCategory;
  articles: HelpArticle[];
}

/**
 * Articles grouped by category in display order; empty categories are
 * left out. Within a category, `order` then title.
 *
 * Example: `articlesByCategory()[0]` → `{ category: { id: "getting-started", … }, articles: [gettingStarted, howToUseHelp] }`.
 */
export function articlesByCategory(
  articles: ReadonlyArray<HelpArticle> = ALL_HELP_ARTICLES,
): HelpCategoryGroup[] {
  return HELP_CATEGORIES.map((category) => ({
    category,
    articles: articles.filter((article) => article.category === category.id).sort(compareArticles),
  })).filter((group) => group.articles.length > 0);
}

/**
 * Every article in reading order: categories in display order, then
 * `order` and title within each.
 */
export function orderedArticles(articles: ReadonlyArray<HelpArticle> = ALL_HELP_ARTICLES): HelpArticle[] {
  return articlesByCategory(articles).flatMap((group) => group.articles);
}

/**
 * The slug an anchor should open: the slug itself, or the article that
 * lists it in `legacyAnchors` (old Settings → Help section ids). Accepts
 * "#anchor" or "anchor"; null when nothing matches.
 *
 * Example: `resolveLegacyAnchor("#build-check-in")` → "build-check-in".
 */
export function resolveLegacyAnchor(
  hash: string,
  articles: ReadonlyArray<HelpArticle> = ALL_HELP_ARTICLES,
): string | null {
  let anchor = hash.startsWith("#") ? hash.slice(1) : hash;
  try {
    anchor = decodeURIComponent(anchor);
  } catch {
    return null;
  }
  anchor = anchor.trim().toLowerCase();
  if (!anchor) return null;
  const direct = articles.find((article) => article.slug === anchor);
  if (direct) return direct.slug;
  return articles.find((article) => article.legacyAnchors?.includes(anchor))?.slug ?? null;
}

/** The articles an article lists as related, skipping unknown slugs. */
export function relatedArticles(article: HelpArticle): HelpArticle[] {
  return article.related
    .map((slug) => getArticle(slug))
    .filter((related): related is HelpArticle => related !== undefined && related.slug !== article.slug);
}

/** The hub's "Popular" list, skipping unknown slugs. */
export function popularArticles(): HelpArticle[] {
  return POPULAR_HELP_SLUGS.map((slug) => getArticle(slug)).filter(
    (article): article is HelpArticle => article !== undefined,
  );
}

const DATE_FORMAT = new Intl.DateTimeFormat("en-US", { dateStyle: "long", timeZone: "UTC" });

/**
 * An article's `updated` date for display. Read as UTC so the day never
 * shifts with the server's or reader's time zone.
 *
 * Example: `formatHelpDate("2026-10-22")` → "October 22, 2026".
 */
export function formatHelpDate(date: string): string {
  return DATE_FORMAT.format(new Date(`${date}T00:00:00Z`));
}

const AUDIENCE_LABEL: Record<HelpArticle["audience"], string | null> = {
  player: "For players",
  streamer: "For streamers",
  all: null,
};

/** "For streamers" / "For players", or null for articles meant for everyone. */
export function helpAudienceLabel(article: HelpArticle): string | null {
  return AUDIENCE_LABEL[article.audience];
}
