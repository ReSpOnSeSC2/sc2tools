// Terran-vs-Zerg build definitions. No matchup-specific entries
// have been authored yet (Terran-generic rules under `terran.ts`
// surface in TvZ via the `matchup: null` fall-through in
// `filterDefinitions`). When the analyzer learns TvZ-specific
// signatures, add them here and they'll be picked up by the facade.
import type { BuildDefinition } from "../build-definitions";

export const TVZ_DEFINITIONS: ReadonlyArray<Omit<BuildDefinition, "id">> = [];
