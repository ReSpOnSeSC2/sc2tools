/**
 * Help search: a small, deterministic token index built from the
 * articles themselves. Runs in the browser as the reader types; no
 * server, no external service, and the same query always returns the
 * same order.
 *
 * Scoring, per article:
 *   - Each token gets the summed weight of the fields it appears in:
 *     title 5, keywords 4, summary (and category name) 2, body 1.
 *   - Each query word takes its best match among the article's tokens:
 *     exact 1×, prefix 0.7× ("pair" → "pairing"), or one edit away 0.5×
 *     when both words have 5+ characters ("expird" → "expired").
 *   - A few short forms also search for what they stand for, at 0.8×
 *     (HELP_SYNONYMS: obs → overlay, code → pairing, ...).
 *   - The sum is scaled by the square of the share of query words that
 *     matched, so an article matching every word beats one that matches
 *     a single word strongly; a title starting a word with the whole
 *     query gets a bonus.
 *   - Ties: higher score, then title, then slug.
 */
import { ALL_HELP_ARTICLES } from "./articles/index.generated";
import { helpArticleBodyText } from "./articleText";
import { helpCategory } from "./categories";
import { helpInlinePlainText } from "./inline";
import type { HelpArticle } from "./types";

export const HELP_FIELD_WEIGHTS = { title: 5, keywords: 4, summary: 2, body: 1 } as const;

/**
 * Short forms readers type, and the words the articles use instead. A
 * multi-word expansion must match every word.
 */
export const HELP_SYNONYMS: Readonly<Record<string, readonly string[]>> = {
  obs: ["overlay"],
  code: ["pairing"],
  tray: ["desktop app"],
  sync: ["upload"],
};

const EXACT = 1;
const PREFIX = 0.7;
const FUZZY = 0.5;
const SYNONYM = 0.8;
const TITLE_PHRASE_BONUS = 5;
const MIN_PREFIX_CHARS = 2;
const MIN_FUZZY_CHARS = 5;
const DEFAULT_LIMIT = 8;

const STOPWORDS: ReadonlySet<string> = new Set([
  "a", "an", "and", "are", "as", "at", "be", "by", "can", "do", "does", "for", "from",
  "how", "i", "if", "in", "is", "it", "its", "me", "my", "of", "on", "or", "so", "the",
  "this", "to", "was", "what", "when", "where", "which", "why", "with", "you", "your",
]);

/**
 * Lowercase words of 2+ letters or digits, accents and apostrophes
 * removed. A leading "!" is kept, so chat commands ("!win") are their
 * own words and don't match "win rate".
 *
 * A word joined by hyphens also counts as one word, so "check-in" is found
 * by "checkin" as well as "check in".
 *
 * Example: `helpSearchTokens("What's the 6-digit code? !rank")` → ["whats", "the", "digit", "code", "!rank"].
 * Example: `helpSearchTokens("Build check-in")` → ["build", "check", "in", "checkin"].
 */
export function helpSearchTokens(text: string): string[] {
  const plain = text
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/['’]/g, "");
  const words = plain.match(/!?[a-z0-9]+/g) ?? [];
  const joined = (plain.match(/[a-z]+(?:-[a-z]+)+/g) ?? []).map((word) => word.replace(/-/g, ""));
  return [...words, ...joined].filter((token) => token.length >= MIN_PREFIX_CHARS);
}

/** True when a and b differ by at most one insertion, deletion or substitution. */
export function withinOneEdit(a: string, b: string): boolean {
  if (a === b) return true;
  if (Math.abs(a.length - b.length) > 1) return false;
  const [short, long] = a.length <= b.length ? [a, b] : [b, a];
  let i = 0;
  let j = 0;
  let edits = 0;
  while (i < short.length && j < long.length) {
    if (short[i] === long[j]) {
      i++;
      j++;
      continue;
    }
    if (++edits > 1) return false;
    if (short.length === long.length) i++;
    j++;
  }
  return edits + (long.length - j) + (short.length - i) <= 1;
}

interface IndexEntry {
  article: HelpArticle;
  /** Token → summed field weight. */
  weights: Map<string, number>;
  /** Title tokens joined by spaces, for the whole-query bonus. */
  titleText: string;
}

export interface HelpSearchIndex {
  entries: readonly IndexEntry[];
}

export interface HelpSearchResult {
  article: HelpArticle;
  score: number;
}

function addField(weights: Map<string, number>, text: string, weight: number): void {
  for (const token of new Set(helpSearchTokens(text))) {
    weights.set(token, (weights.get(token) ?? 0) + weight);
  }
}

/** Build the token index for a set of articles. */
export function buildHelpSearchIndex(articles: ReadonlyArray<HelpArticle> = ALL_HELP_ARTICLES): HelpSearchIndex {
  return {
    entries: articles.map((article) => {
      const weights = new Map<string, number>();
      addField(weights, article.title, HELP_FIELD_WEIGHTS.title);
      addField(weights, article.keywords.join(" "), HELP_FIELD_WEIGHTS.keywords);
      addField(
        weights,
        `${helpInlinePlainText(article.summary)} ${helpCategory(article.category).name}`,
        HELP_FIELD_WEIGHTS.summary,
      );
      addField(weights, helpArticleBodyText(article), HELP_FIELD_WEIGHTS.body);
      return { article, weights, titleText: helpSearchTokens(article.title).join(" ") };
    }),
  };
}

let defaultIndex: HelpSearchIndex | null = null;

/** The index over every shipped article, built on first use. */
function shippedIndex(): HelpSearchIndex {
  defaultIndex ??= buildHelpSearchIndex();
  return defaultIndex;
}

function tokenScore(term: string, entry: IndexEntry): number {
  let best = 0;
  for (const [token, weight] of entry.weights) {
    let quality = 0;
    if (token === term) quality = EXACT;
    else if (token.startsWith(term)) quality = PREFIX;
    else if (term.length >= MIN_FUZZY_CHARS && token.length >= MIN_FUZZY_CHARS && withinOneEdit(term, token)) {
      quality = FUZZY;
    }
    if (quality === EXACT) return weight;
    best = Math.max(best, weight * quality);
  }
  return best;
}

/** A synonym phrase scores only when every word matches: the average of its words. */
function phraseScore(phrase: string, entry: IndexEntry): number {
  const words = helpSearchTokens(phrase);
  let total = 0;
  for (const word of words) {
    const score = tokenScore(word, entry);
    if (score === 0) return 0;
    total += score;
  }
  return words.length ? total / words.length : 0;
}

function termScore(term: string, entry: IndexEntry): number {
  let best = tokenScore(term, entry);
  for (const phrase of HELP_SYNONYMS[term] ?? []) {
    best = Math.max(best, phraseScore(phrase, entry) * SYNONYM);
  }
  return best;
}

function queryTerms(query: string): string[] {
  const tokens = [...new Set(helpSearchTokens(query))];
  const meaningful = tokens.filter((token) => !STOPWORDS.has(token));
  return meaningful.length ? meaningful : tokens;
}

/**
 * Articles matching a query, best first.
 *
 * Example: `searchHelp("obs browser source")[0].article.slug` → "obs-overlay-setup".
 */
export function searchHelp(
  query: string,
  options: { index?: HelpSearchIndex; limit?: number } = {},
): HelpSearchResult[] {
  const terms = queryTerms(query);
  if (terms.length === 0) return [];
  const phrase = terms.join(" ");
  const results: HelpSearchResult[] = [];
  for (const entry of (options.index ?? shippedIndex()).entries) {
    let total = 0;
    let matched = 0;
    for (const term of terms) {
      const score = termScore(term, entry);
      if (score > 0) {
        matched++;
        total += score;
      }
    }
    if (matched === 0) continue;
    const coverage = matched / terms.length;
    let score = total * coverage * coverage;
    // Whole query at the start of a title word ("obs over" → "OBS overlay setup").
    if (` ${entry.titleText}`.includes(` ${phrase}`)) score += TITLE_PHRASE_BONUS;
    results.push({ article: entry.article, score });
  }
  results.sort(
    (a, b) =>
      b.score - a.score ||
      a.article.title.localeCompare(b.article.title, "en") ||
      (a.article.slug < b.article.slug ? -1 : 1),
  );
  return results.slice(0, options.limit ?? DEFAULT_LIMIT);
}
