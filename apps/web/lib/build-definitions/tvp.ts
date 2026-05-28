// Terran-vs-Protoss build definitions. No matchup-specific entries have
// been authored yet -- Terran-generic rules under `terran.ts` surface in
// TvP via the `matchup: null` fall-through in `filterDefinitions`. The
// 1-base 1-1-1 all-in is detected by the shared race classifier and
// labelled with its canonical name `Terran - 1-1-1 One Base` (see
// `terran.ts`), so it is not duplicated here. When the analyzer learns
// TvP-specific signatures, add them here and they'll be picked up by the
// facade.
import type { BuildDefinition } from "../build-definitions";

export const TVP_DEFINITIONS: ReadonlyArray<Omit<BuildDefinition, "id">> = [];
