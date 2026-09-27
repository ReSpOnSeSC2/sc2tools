/**
 * Guide catalog — which /definitions entries are OPENERS (and so can get a
 * community build-guide page), plus the serialisable catalog the API ships
 * as `apps/api/src/config/guideCatalog.json`.
 *
 * The API Docker image does not include `apps/web`, so the API cannot
 * import `BUILD_DEFINITIONS` directly. `scripts/export-guide-catalog.mjs`
 * (`npm run guides:catalog`) bundles this module and writes
 * `buildGuideCatalog()` to the API config folder; the vitest drift test in
 * `lib/guides/__tests__/slugs.test.ts` fails whenever the committed JSON and
 * this module disagree, so a catalog edit here must be followed by a
 * re-export.
 *
 * A definition is NOT an opener when it is a mid/late-game composition, a
 * fallback / unclassified label or a game-length marker: none of those is a
 * build a player can choose to queue with, so none gets a guide page. The
 * name patterns additionally catch never-emitted legacy composition names
 * and any future catch-all label.
 */
import {
  BUILD_DEFINITIONS,
  type BuildDefinition,
  type StrategyMatchup,
} from "@/lib/build-definitions";
import type { Race } from "@/lib/race";

/** Catalog ids that never get a guide page (see module comment). */
export const GUIDE_NON_OPENER_IDS: ReadonlySet<string> = new Set([
  // mid/late-game compositions and transitions — no opening to adapt
  "protoss-chargelot-archon-comp",
  "protoss-robo-comp",
  "protoss-skytoss-transition",
  "terran-bio-comp",
  "terran-mech-comp",
  "terran-skyterran",
  "zerg-muta-ling-bane-comp",
  // fallback / unclassified labels
  "protoss-standard-play-unclassified",
  "terran-standard-play-unclassified",
  "zerg-standard-play-unclassified",
  "pvp-macro-transition-unclassified",
  "pvt-macro-transition-unclassified",
  "pvz-macro-transition-unclassified",
  // game-length markers
  "pvp-game-too-short",
  "pvt-game-too-short",
  "pvz-game-too-short",
  "tvp-game-too-short",
  "tvt-game-too-short",
  "tvz-game-too-short",
  "zvp-game-too-short",
  "zvt-game-too-short",
  "zvz-game-too-short",
]);

/**
 * Name patterns that are never openers, whatever their id: compositions
 * ("… Comp"), catch-alls ("… (Unclassified)", "Unclassified - <Race>") and
 * game-length markers ("… - Game Too Short").
 */
export const GUIDE_NON_OPENER_NAME_PATTERNS: ReadonlyArray<RegExp> = [
  /Comp$/,
  /\(Unclassified\)$/,
  /^Unclassified\b/,
  /Game Too Short$/,
];

/** One row of `apps/api/src/config/guideCatalog.json`. */
export interface GuideCatalogEntry {
  /** Exact catalog name — the join key with stored `myBuild` / `opponent.strategy`. */
  name: string;
  /** Owning race. */
  race: Race;
  /** Matchup for matchup-prefixed names; null for race-prefixed names. */
  matchup: StrategyMatchup;
  /** Detection rule prose, verbatim from the catalog. */
  description: string;
  /** True when the definition can get a guide page. */
  opener: boolean;
}

/**
 * True when a catalog definition describes an opener (see module comment).
 *
 * Example: `isGuideOpenerDefinition({ id: "zerg-8-pool", name: "Zerg - 8 Pool" })`
 * → true; `"PvZ - Game Too Short"` → false.
 */
export function isGuideOpenerDefinition(
  def: Pick<BuildDefinition, "id" | "name">,
): boolean {
  if (GUIDE_NON_OPENER_IDS.has(def.id)) return false;
  return !GUIDE_NON_OPENER_NAME_PATTERNS.some((pattern) =>
    pattern.test(def.name),
  );
}

/** Plain code-unit order so the export is identical on every machine/locale. */
function compareByName(a: GuideCatalogEntry, b: GuideCatalogEntry): number {
  if (a.name < b.name) return -1;
  return a.name > b.name ? 1 : 0;
}

/**
 * The serialisable guide catalog, sorted by name. Key order inside each
 * entry is fixed (`name, race, matchup, description, opener`) so the
 * exported JSON diff stays readable.
 *
 * Example: `buildGuideCatalog()[0]` →
 * `{ name: "Protoss - 4 Gate Rush", race: "Protoss", matchup: null, … }`.
 */
export function buildGuideCatalog(
  defs: ReadonlyArray<BuildDefinition> = BUILD_DEFINITIONS,
): GuideCatalogEntry[] {
  return defs
    .map((def) => ({
      name: def.name,
      race: def.race,
      matchup: def.matchup,
      description: def.description,
      opener: isGuideOpenerDefinition(def),
    }))
    .sort(compareByName);
}
