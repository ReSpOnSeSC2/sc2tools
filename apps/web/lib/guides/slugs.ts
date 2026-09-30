/**
 * Guide slugs (web mirror) — the per-matchup URL keys of the community
 * build guides, computed from `BUILD_DEFINITIONS` with exactly the rule in
 * `apps/api/src/config/guideSlugs.js`. The vitest suite asserts this
 * mapping deep-equals the API's committed `guideSlugs.lock.json`, so the
 * links the web builds always resolve on the API.
 *
 * Two namespaces per matchup M = XvY (the viewer's matchup):
 *   - builds   — the user's own openers: "XvY - …" names, plus the
 *                race-generic "<X race> - …" names when X is Terran/Zerg
 *                (Protoss users are only ever labelled "PvX - …").
 *   - counters — the opponent's openers (labelled from THEIR side):
 *                "YvX - …" plus "<Y race> - …"; only "Protoss - …" when Y
 *                is Protoss.
 * Slug = text after the first " - ", lowercased, non-alphanumeric runs →
 * "-", trimmed. On a collision the matchup-prefixed name keeps the plain
 * slug and the race-generic one becomes "<race>-<slug>".
 */
import {
  BUILD_DEFINITIONS,
  type StrategyMatchup,
} from "@/lib/build-definitions";
import { isGuideOpenerDefinition } from "@/lib/guides/catalog";

export type GuideMatchup = NonNullable<StrategyMatchup>;
export type GuideSlugKind = "builds" | "counters";
/** matchup slug ("pvz") → { slug → exact catalog name }. */
export type GuideSlugNamespaceTable = Record<string, Record<string, string>>;
/** Same shape as `apps/api/src/config/guideSlugs.lock.json`. */
export type GuideSlugTable = Record<GuideSlugKind, GuideSlugNamespaceTable>;

/** A guide build or strategy option (admin pickers, link lists). */
export interface GuideSlugOption {
  name: string;
  slug: string;
}

/** The nine 1v1 matchups, viewer race first. */
export const GUIDE_MATCHUPS: ReadonlyArray<GuideMatchup> = [
  "PvP",
  "PvT",
  "PvZ",
  "TvP",
  "TvT",
  "TvZ",
  "ZvP",
  "ZvT",
  "ZvZ",
];

export const GUIDES_BASE_PATH = "/guides";
const COUNTER_SEGMENT = "counter";
const MAPS_SEGMENT = "maps";
const NAME_SEPARATOR = " - ";
/** Upper bound on a slug's length (mirrors the API and the catalog id cap). */
const SLUG_MAX_CHARS = 80;
const MY_RACE_INDEX = 0;
const OPP_RACE_INDEX = 2;
const PROTOSS_LETTER = "P";
const RACE_WORDS: Readonly<Record<string, string>> = {
  P: "Protoss",
  T: "Terran",
  Z: "Zerg",
};
const SLUG_KINDS: ReadonlyArray<GuideSlugKind> = ["builds", "counters"];
const GUIDE_MATCHUP_SET: ReadonlySet<string> = new Set(GUIDE_MATCHUPS);

interface SlugNamespace {
  names: ReadonlyArray<string>;
  bySlug: ReadonlyMap<string, string>;
  byName: ReadonlyMap<string, string>;
}

/**
 * Slugify free text with the guide rule (diacritics folded first).
 *
 * Example: `guideSlugify("Stargate into Glaives")` → "stargate-into-glaives".
 */
export function guideSlugify(text: string): string {
  return text
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, SLUG_MAX_CHARS)
    .replace(/-+$/, "");
}

/**
 * Human title of a catalog name: the text after the first " - ".
 *
 * Example: `guideDisplayName("PvZ - Stargate into Glaives")` → "Stargate into Glaives".
 */
export function guideDisplayName(name: string): string {
  const at = name.indexOf(NAME_SEPARATOR);
  return at < 0 ? name : name.slice(at + NAME_SEPARATOR.length);
}

function namePrefix(name: string): string | null {
  const at = name.indexOf(NAME_SEPARATOR);
  return at < 0 ? null : name.slice(0, at);
}

/** Type guard for the "PvZ"-form matchup strings. */
export function isGuideMatchup(value: unknown): value is GuideMatchup {
  return typeof value === "string" && GUIDE_MATCHUP_SET.has(value);
}

/**
 * Matchup for a canonical (lowercase) matchup URL segment.
 *
 * Example: `matchupFromGuideSlug("pvz")` → "PvZ"; `"PVZ"` → null.
 */
export function matchupFromGuideSlug(slug: unknown): GuideMatchup | null {
  if (typeof slug !== "string") return null;
  return GUIDE_MATCHUPS.find((m) => m.toLowerCase() === slug) ?? null;
}

/**
 * Matchup of a matchup-prefixed catalog name; null for race-generic
 * ("Zerg - 12 Pool") and non-catalog names.
 *
 * Example: `matchupFromBuildName("PvZ - Stargate into Glaives")` → "PvZ".
 */
export function matchupFromBuildName(name: string): GuideMatchup | null {
  const prefix = namePrefix(name);
  return isGuideMatchup(prefix) ? prefix : null;
}

function namespacePrefixes(
  kind: GuideSlugKind,
  matchup: GuideMatchup,
): { matchupPrefix: string | null; raceWord: string | null } {
  const mine = matchup[MY_RACE_INDEX];
  const theirs = matchup[OPP_RACE_INDEX];
  if (kind === "builds") {
    return {
      matchupPrefix: matchup,
      raceWord: mine === PROTOSS_LETTER ? null : RACE_WORDS[mine] ?? null,
    };
  }
  return {
    matchupPrefix: theirs === PROTOSS_LETTER ? null : `${theirs}v${mine}`,
    raceWord: RACE_WORDS[theirs] ?? null,
  };
}

function assignSlugs(
  names: ReadonlyArray<string>,
  raceWord: string | null,
): Map<string, string> {
  const plain = new Map(
    names.map((name) => [name, guideSlugify(guideDisplayName(name))]),
  );
  const matchupOwned = new Set(
    names.filter((name) => namePrefix(name) !== raceWord).map((name) => plain.get(name)),
  );
  const byName = new Map<string, string>();
  const seen = new Set<string>();
  for (const name of names) {
    const base = plain.get(name) ?? "";
    const isGeneric = namePrefix(name) === raceWord;
    const slug =
      isGeneric && matchupOwned.has(base) ? guideSlugify(`${raceWord}-${base}`) : base;
    if (!slug || seen.has(slug)) {
      throw new Error(`guide slug "${slug}" is empty or collides (${name})`);
    }
    seen.add(slug);
    byName.set(name, slug);
  }
  return byName;
}

function buildNamespace(
  openerNames: ReadonlyArray<string>,
  kind: GuideSlugKind,
  matchup: GuideMatchup,
): SlugNamespace {
  const { matchupPrefix, raceWord } = namespacePrefixes(kind, matchup);
  const names = openerNames
    .filter((name) => {
      const prefix = namePrefix(name);
      return prefix !== null && (prefix === matchupPrefix || prefix === raceWord);
    })
    .sort();
  const byName = assignSlugs(names, raceWord);
  const bySlug = new Map([...byName].map(([name, slug]) => [slug, name]));
  return { names, bySlug, byName };
}

const OPENER_NAMES: ReadonlyArray<string> = BUILD_DEFINITIONS.filter(
  isGuideOpenerDefinition,
).map((def) => def.name);

const NAMESPACES: Record<GuideSlugKind, ReadonlyMap<string, SlugNamespace>> = {
  builds: new Map(GUIDE_MATCHUPS.map((m) => [m, buildNamespace(OPENER_NAMES, "builds", m)])),
  counters: new Map(
    GUIDE_MATCHUPS.map((m) => [m, buildNamespace(OPENER_NAMES, "counters", m)]),
  ),
};

function compareFirst(a: [string, string], b: [string, string]): number {
  if (a[0] < b[0]) return -1;
  return a[0] > b[0] ? 1 : 0;
}

/**
 * The full mapping in the lock-file shape
 * (`{ builds: { pvz: { slug: name } }, counters: { … } }`, slugs sorted).
 */
export function guideSlugTable(): GuideSlugTable {
  const table: GuideSlugTable = { builds: {}, counters: {} };
  for (const kind of SLUG_KINDS) {
    for (const [matchup, ns] of NAMESPACES[kind]) {
      table[kind][matchup.toLowerCase()] = Object.fromEntries(
        [...ns.bySlug].sort(compareFirst),
      );
    }
  }
  return table;
}

/**
 * Slug of the viewer's own build in a matchup, or null when the name is
 * not a guide build there.
 *
 * Example: `guideBuildSlug("ZvP", "Zerg - 2 Base Nydus")` → "zerg-2-base-nydus".
 */
export function guideBuildSlug(matchup: string, name: string): string | null {
  return NAMESPACES.builds.get(matchup)?.byName.get(name) ?? null;
}

/**
 * Slug of an opponent strategy (their label) for the viewer's matchup.
 *
 * Example: `guideStrategySlug("PvZ", "ZvP - Ling Bane Bust")` → "ling-bane-bust".
 */
export function guideStrategySlug(matchup: string, name: string): string | null {
  return NAMESPACES.counters.get(matchup)?.byName.get(name) ?? null;
}

function optionsFor(kind: GuideSlugKind, matchup: string): GuideSlugOption[] {
  const ns = NAMESPACES[kind].get(matchup);
  if (!ns) return [];
  return ns.names.map((name) => ({ name, slug: ns.byName.get(name) ?? "" }));
}

/** Guide builds of a matchup, sorted by catalog name (empty for unknown). */
export function guideBuildOptions(matchup: string): GuideSlugOption[] {
  return optionsFor("builds", matchup);
}

/** Opponent strategies with a counter page for a matchup, sorted by name. */
export function guideStrategyOptions(matchup: string): GuideSlugOption[] {
  return optionsFor("counters", matchup);
}

/**
 * Matchup page path. Accepts "PvZ" or "pvz".
 *
 * Example: `guideMatchupPath("PvZ")` → "/guides/pvz".
 */
export function guideMatchupPath(matchup: string): string {
  return `${GUIDES_BASE_PATH}/${guideSlugify(matchup)}`;
}

/**
 * Build guide path, or null when the name has no guide in that matchup.
 *
 * Example: `guideBuildPath("PvZ", "PvZ - Stargate into Glaives")` →
 * "/guides/pvz/stargate-into-glaives".
 */
export function guideBuildPath(matchup: string, name: string): string | null {
  const slug = guideBuildSlug(matchup, name);
  return slug ? `${guideMatchupPath(matchup)}/${slug}` : null;
}

/**
 * Counter page path for an opponent strategy in the viewer's matchup.
 *
 * Example: `guideCounterPath("PvZ", "Zerg - 12 Pool")` → "/guides/pvz/counter/12-pool".
 */
export function guideCounterPath(matchup: string, name: string): string | null {
  const slug = guideStrategySlug(matchup, name);
  return slug ? `${guideMatchupPath(matchup)}/${COUNTER_SEGMENT}/${slug}` : null;
}

/**
 * Map guide path (slug of the full map name), or null for a name with no
 * ASCII letters/digits.
 *
 * Example: `guideMapPath("Alcyone LE")` → "/guides/maps/alcyone-le".
 */
export function guideMapPath(mapName: string): string | null {
  const slug = guideSlugify(mapName);
  return slug ? `${GUIDES_BASE_PATH}/${MAPS_SEGMENT}/${slug}` : null;
}
