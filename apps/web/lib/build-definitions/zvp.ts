// Zerg-vs-Protoss build definitions. No matchup-specific entries
// have been authored yet (Zerg-generic rules under `zerg.ts`
// surface in ZvP via the `matchup: null` fall-through in
// `filterDefinitions`). When the analyzer learns ZvP-specific
// signatures, add them here and they'll be picked up by the facade.
import type { BuildDefinition } from "../build-definitions";

export const ZVP_DEFINITIONS: ReadonlyArray<Omit<BuildDefinition, "id">> = [];
