/**
 * Build & Strategy definitions catalog — every label the analyzer can put
 * on a game, for your build and your opponent's. Surfaced on /definitions
 * so users can interpret labels they see on the dashboard, opponent
 * profile and builds page. `DEFINITIONS_TOTAL` is the live count.
 *
 * Source of truth: the replay engine, apps/replay-engine/core/build_definitions.py.
 * The catalog is assembled from three layers:
 *   1. `build-definitions.generated.json` — every engine label with its
 *      race, matchup, the engine's description and its 8-worker patch
 *      names. Written by `npm run definitions:gen`; never edited by hand.
 *   2. `./build-definitions/wording.ts` — WORDING OVERRIDES: a hand-written
 *      description for an engine label, matched by exact name, kept only
 *      where it says more than the engine. Every other label shows the
 *      engine's own text, so a rule change there reaches this page.
 *   3. `SUPPLEMENTARY_DEFINITIONS` — labels the engine builds at run time
 *      rather than listing in its catalog ("<Matchup> - Game Too Short").
 * lib/__tests__/buildDefinitionsParity.test.ts fails when an engine label
 * has no entry here, when an override names a label the engine no longer
 * has or repeats its text, and when the generated file is stale.
 *
 * Categorisation:
 *   - `race`       — owning race (Protoss/Terran/Zerg).
 *   - `matchup`    — narrower matchup tag, when the rule is matchup-specific.
 *   - `name`       — the label, exactly as the analyzer stores it.
 *   - `description`— how the label is detected, in plain words.
 *   - `eightWorkerName` — the name the analyzer uses instead on the
 *                    8-worker patch 5.0.16 ("Zerg - 8 Pool").
 */
import type { Race } from "@/lib/race";

import generatedCatalog from "./build-definitions.generated.json";
import { TOO_SHORT_DEFINITIONS } from "./build-definitions/too-short";
import { DEFINITION_WORDING } from "./build-definitions/wording";

export type StrategyMatchup =
  | "PvP"
  | "PvT"
  | "PvZ"
  | "TvP"
  | "TvT"
  | "TvZ"
  | "ZvP"
  | "ZvT"
  | "ZvZ"
  | null;

export interface BuildDefinition {
  /** Unique slug derived from the rule name (e.g. "pvp-1-gate-expand"). */
  id: string;
  /** Owning race. */
  race: Race;
  /** Optional narrower matchup. Null when the rule applies to all matchups for `race`. */
  matchup: StrategyMatchup;
  /** Display title — verbatim from the analyzer. */
  name: string;
  /** Detection rule prose. */
  description: string;
  /** The label's name on the 8-worker patch 5.0.16, when it differs. */
  eightWorkerName?: string;
}

/** One engine label as `npm run definitions:gen` writes it. */
export interface EngineDefinition {
  name: string;
  race: Race;
  matchup: StrategyMatchup;
  description: string;
  eightWorkerName?: string;
}

/** Every label in the engine's catalog (the generated layer). */
export const ENGINE_DEFINITIONS: ReadonlyArray<EngineDefinition> =
  generatedCatalog.definitions as ReadonlyArray<EngineDefinition>;

/** Labels the engine emits that aren't in its catalog (built at run time). */
export const SUPPLEMENTARY_DEFINITIONS: ReadonlyArray<Omit<BuildDefinition, "id">> =
  TOO_SHORT_DEFINITIONS;

/**
 * Display order: race-generic entries before each race's matchups
 * (Protoss, PvP, PvT, PvZ, Terran, …, ZvZ); inside a group, named builds
 * by name, then the catch-alls (Unclassified, Game Too Short).
 */
const GROUP_ORDER: ReadonlyArray<string> = [
  "Protoss", "PvP", "PvT", "PvZ",
  "Terran", "TvP", "TvT", "TvZ",
  "Zerg", "ZvP", "ZvT", "ZvZ",
];
const CATCH_ALL_RE = /\(Unclassified\)$|Game Too Short$/;

function groupRank(def: Pick<BuildDefinition, "race" | "matchup">): number {
  const rank = GROUP_ORDER.indexOf(def.matchup ?? def.race);
  return rank < 0 ? GROUP_ORDER.length : rank;
}

function compareDefinitions(
  a: Omit<BuildDefinition, "id">,
  b: Omit<BuildDefinition, "id">,
): number {
  const group = groupRank(a) - groupRank(b);
  if (group !== 0) return group;
  const catchAll = Number(CATCH_ALL_RE.test(a.name)) - Number(CATCH_ALL_RE.test(b.name));
  if (catchAll !== 0) return catchAll;
  return a.name < b.name ? -1 : a.name > b.name ? 1 : 0;
}

function slugifyDef(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80);
}

const WORDING_BY_NAME: ReadonlyMap<string, string> = new Map(
  Object.entries(DEFINITION_WORDING),
);

const RAW_DEFINITIONS: ReadonlyArray<Omit<BuildDefinition, "id">> = [
  ...ENGINE_DEFINITIONS.map((engine) => ({
    race: engine.race,
    matchup: engine.matchup,
    name: engine.name,
    description: WORDING_BY_NAME.get(engine.name) ?? engine.description,
    ...(engine.eightWorkerName ? { eightWorkerName: engine.eightWorkerName } : {}),
  })),
  ...SUPPLEMENTARY_DEFINITIONS,
].sort(compareDefinitions);

export const BUILD_DEFINITIONS: ReadonlyArray<BuildDefinition> =
  RAW_DEFINITIONS.map((d) => ({
    ...d,
    id: slugifyDef(d.name),
  }));

export const DEFINITIONS_TOTAL = BUILD_DEFINITIONS.length;

export function filterDefinitions(
  defs: ReadonlyArray<BuildDefinition>,
  query: string,
  race: Race | "All",
  matchup: StrategyMatchup | "All",
): BuildDefinition[] {
  const q = query.trim().toLowerCase();
  return defs.filter((d) => {
    if (race !== "All" && d.race !== race) return false;
    if (matchup !== "All" && matchup !== null) {
      // `matchup: null` on a definition means "applies to every matchup
      // for this race" (see the type comment above), so a generic rule
      // like "Protoss - 4 Gate Rush" must surface under PvP, PvT, and
      // PvZ. Without this branch every Terran/Zerg entry (all `null`)
      // would vanish whenever the user picked TvT/TvZ/.../ZvZ.
      if (d.matchup !== null && d.matchup !== matchup) return false;
    }
    if (!q) return true;
    return (
      d.name.toLowerCase().includes(q) ||
      d.description.toLowerCase().includes(q) ||
      Boolean(d.eightWorkerName?.toLowerCase().includes(q))
    );
  });
}
