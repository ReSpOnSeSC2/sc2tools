import { helpSearchTokens } from "./help/search";
import { isCommandSearchHref } from "./commandSearchTarget";
export { isCommandSearchHref } from "./commandSearchTarget";

/** Lazy palette data only: never import this module from eager chrome. */
export const COMMAND_SEARCH_GROUPS = [
  { id: "recent", label: "Recent" },
  { id: "navigation", label: "Pages" },
  { id: "settings", label: "Settings" },
  { id: "help", label: "Help" },
  { id: "glossary", label: "Glossary" },
  { id: "definitions", label: "Build definitions" },
  { id: "widgets", label: "Stream widgets" },
  { id: "actions", label: "Actions" },
  { id: "guide-openers", label: "Openers" },
  { id: "guide-counters", label: "How to beat" },
  { id: "guide-maps", label: "Maps" },
] as const;

export type CommandSearchGroupId = (typeof COMMAND_SEARCH_GROUPS)[number]["id"];
export type CommandSearchAction = "pair-device" | "report-problem" | "whats-new" | "toggle-theme" | "shortcuts";
export type CommandSearchItem = {
  readonly id: string;
  readonly group: CommandSearchGroupId;
  readonly label: string;
  readonly description?: string;
  readonly terms?: readonly string[];
  readonly href?: string;
  readonly action?: CommandSearchAction;
  readonly disabled?: boolean;
  readonly matchup?: string;
};
export type CommandSearchGroup = {
  readonly id: CommandSearchGroupId;
  readonly label: string;
  readonly items: readonly CommandSearchItem[];
};

export const COMMAND_QUERY_MAX_CHARS = 80;
export const COMMAND_RESULTS_PER_GROUP = 8;
export const COMMAND_RESULTS_MAX = 60;
const QUERY_TOKENS_MAX = 12;
const CANDIDATES_MAX = 5_000;
const STOPWORDS = new Set(["a", "an", "the", "how", "to", "of", "for"]);
const RACE_LETTERS: Readonly<Record<string, string>> = { protoss: "p", terran: "t", zerg: "z" };

function foldText(value: string): string {
  return value.normalize("NFKD").replace(/[\u0300-\u036f]/g, "").toLowerCase()
    .replace(/\p{Cc}/gu, " ").replace(/\s+/g, " ").trim();
}

/** Bounded normalized query; race order is preserved. Example: "Protoss vs Zerg" -> "pvz". */
export function normalizeCommandQuery(query: string): string {
  const bounded = Array.from(query.slice(0, COMMAND_QUERY_MAX_CHARS * 2)).slice(0, COMMAND_QUERY_MAX_CHARS).join("");
  const folded = foldText(bounded)
    .replace(/\b(protoss|terran|zerg)\s+(?:vs?\.?|versus)\s+(protoss|terran|zerg)\b/g,
      (_match, own: string, opponent: string) => `${RACE_LETTERS[own]}v${RACE_LETTERS[opponent]}`)
    .replace(/\b([ptz])\s*v(?:s)?\.?\s*([ptz])\b/g, "$1v$2");
  return Array.from(folded).slice(0, COMMAND_QUERY_MAX_CHARS).join("").trim();
}

/** Returns an explicit matchup alias, if present. Example: "beat 12 pool pvz" -> "PvZ". */
export function commandQueryMatchup(query: string): string | null {
  const match = /\b([ptz])v([ptz])\b/.exec(normalizeCommandQuery(query));
  return match ? `${match[1].toUpperCase()}v${match[2].toUpperCase()}` : null;
}

function tokens(value: string): string[] {
  const separated = value.replace(/(\d)([a-z])/gi, "$1 $2").replace(/([a-z])(\d)/gi, "$1 $2");
  const words = [...helpSearchTokens(separated), ...(separated.match(/\b\d+\b/g) ?? [])];
  return [...new Set(words.filter(token => !STOPWORDS.has(token)))];
}

function tokenWeight(token: string, fields: readonly string[][]): number {
  const index = fields.findIndex(words => words.includes(token));
  if (index >= 0) return [8, 4, 1][index];
  const prefix = fields.findIndex(words => words.some(word => word.startsWith(token)));
  return prefix < 0 ? 0 : [4, 2, 0.5][prefix];
}

function itemScore(item: CommandSearchItem, query: string, queryTokens: readonly string[]): number {
  if (!query) return 1;
  const label = foldText(item.label);
  const aliases = (item.terms ?? []).map(foldText);
  if (label === query) return 1_000;
  if (aliases.includes(query)) return 900;
  const fields = [tokens(label), tokens(aliases.join(" ")), tokens(item.description ?? "")];
  const weights = queryTokens.map(token => tokenWeight(token, fields));
  if (!weights.length || weights.includes(0)) return 0;
  return weights.reduce((sum, value) => sum + value, 0) + (label.startsWith(query) ? 20 : 0);
}

function matchesScope(item: CommandSearchItem, matchup: string | null): boolean {
  return !matchup || !item.group.startsWith("guide-") || !item.matchup || item.matchup === matchup;
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : Number(left > right);
}

function rankedItems(items: readonly CommandSearchItem[], query: string) {
  const matchup = commandQueryMatchup(query);
  const queryTokens = tokens(query).slice(0, QUERY_TOKENS_MAX);
  const seen = new Set<string>();
  return items.slice(0, CANDIDATES_MAX).filter(item => {
    if (query && item.group === "recent") return false;
    if (seen.has(item.id) || !matchesScope(item, matchup)) return false;
    if (item.href && !isCommandSearchHref(item.href)) return false;
    seen.add(item.id);
    return true;
  }).map(item => ({ item, score: itemScore(item, query, queryTokens) }))
    .filter(result => result.score > 0)
    .sort((left, right) => right.score - left.score
      || compareText(foldText(left.item.label), foldText(right.item.label))
      || compareText(left.item.id, right.item.id));
}

/** Deterministic local groups, at most 8 rows/group and 60 total. Example: searchCommands(items, "tts"). */
export function searchCommands(
  items: readonly CommandSearchItem[], query: string, groups?: readonly CommandSearchGroupId[],
): CommandSearchGroup[] {
  const ranked = rankedItems(items, normalizeCommandQuery(query));
  const allowed = groups ? new Set(groups) : null;
  const result: CommandSearchGroup[] = [];
  let remaining = COMMAND_RESULTS_MAX;
  for (const group of COMMAND_SEARCH_GROUPS) {
    if (allowed && !allowed.has(group.id)) continue;
    const matches = ranked.filter(entry => entry.item.group === group.id)
      .slice(0, Math.min(COMMAND_RESULTS_PER_GROUP, remaining)).map(entry => entry.item);
    if (matches.length) result.push({ ...group, items: matches });
    remaining -= matches.length;
  }
  return result;
}
