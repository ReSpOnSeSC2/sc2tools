/**
 * Build & Strategy definitions catalog — the 101 detection rules used
 * by the analyzer to label opponent strategies and the player's own
 * builds. Surfaced on /definitions so users can interpret labels they
 * see on the dashboard, opponent profile, and builds page.
 *
 * Source of truth: the rules implemented in
 * `apps/api/src/services/strategyClassifier.js` (and its predecessor
 * `stream-overlay-backend/analyzer/strategy_rules.js`). When a rule
 * threshold changes there, mirror it here so the public catalog
 * stays accurate.
 *
 * The catalog itself lives in per-matchup chunk files under
 * `./build-definitions/`; this module assembles them, slugifies each
 * entry's id, and exposes the public surface (`BUILD_DEFINITIONS`,
 * `DEFINITIONS_TOTAL`, `filterDefinitions`).
 *
 * Categorisation:
 *   - `race`       — owning race (Protoss/Terran/Zerg).
 *   - `matchup`    — narrower matchup tag, when the rule is matchup-specific.
 *   - `name`       — human title, displayed verbatim on /definitions.
 *   - `description`— the full text the analyzer attaches when the rule fires.
 */
import type { Race } from "@/lib/race";

import { PROTOSS_DEFINITIONS } from "./build-definitions/protoss";
import { PVP_DEFINITIONS } from "./build-definitions/pvp";
import { PVT_DEFINITIONS } from "./build-definitions/pvt";
import { PVZ_DEFINITIONS } from "./build-definitions/pvz";
import { TERRAN_DEFINITIONS } from "./build-definitions/terran";
import { TOO_SHORT_DEFINITIONS } from "./build-definitions/too-short";
import { TVP_DEFINITIONS } from "./build-definitions/tvp";
import { TVT_DEFINITIONS } from "./build-definitions/tvt";
import { TVZ_DEFINITIONS } from "./build-definitions/tvz";
import { ZERG_DEFINITIONS } from "./build-definitions/zerg";
import { ZVP_DEFINITIONS } from "./build-definitions/zvp";
import { ZVT_DEFINITIONS } from "./build-definitions/zvt";
import { ZVZ_DEFINITIONS } from "./build-definitions/zvz";

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
  /** Detection rule prose — verbatim from the analyzer. */
  description: string;
}

// Concatenation order matches the original monolith section order
// (Protoss-generic → PvP → PvT → PvZ → Terran → Zerg → Too-Short),
// with the single Terran-TvP entry pulled into its own tvp.ts and
// re-inserted right after the Terran-generic block so that the
// resulting `BUILD_DEFINITIONS` array stays close to the original
// ordering and slugified ids are produced in a stable sequence.
//
// TvT / TvZ / ZvP / ZvT / ZvZ are scaffolded as empty arrays today
// (the analyzer has no matchup-specific signatures for them yet).
// Grouping the imports by race means a future TvT entry just needs to
// land in tvt.ts and will appear in the catalog automatically.
const RAW_DEFINITIONS: ReadonlyArray<Omit<BuildDefinition, "id">> = [
  ...PROTOSS_DEFINITIONS,
  ...PVP_DEFINITIONS,
  ...PVT_DEFINITIONS,
  ...PVZ_DEFINITIONS,
  ...TERRAN_DEFINITIONS,
  ...TVP_DEFINITIONS,
  ...TVT_DEFINITIONS,
  ...TVZ_DEFINITIONS,
  ...ZERG_DEFINITIONS,
  ...ZVP_DEFINITIONS,
  ...ZVT_DEFINITIONS,
  ...ZVZ_DEFINITIONS,
  ...TOO_SHORT_DEFINITIONS,
];

function slugifyDef(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80);
}

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
      d.description.toLowerCase().includes(q)
    );
  });
}
