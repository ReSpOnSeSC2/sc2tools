/**
 * "Add to randomizer pool" from the build library: put saved builds into
 * every matchup pool they fit (their race against the opponent race, or
 * any race), the way the randomizer settings' picker adds one. Loaded on
 * demand so the library page never ships the randomizer code.
 */
import { coerceRace, coerceVsRace } from "@/lib/race";
import { sanitizeRandomizerConfig, toggleBuild, withMatchup } from "./config";
import { defaultOpeningUnits, inferGatewayCount } from "./gatewayUnits";
import { MATCHUPS, matchupRaces, type MatchupKey, type RandomizerConfig } from "./types";

export interface PoolBuild {
  slug: string;
  name: string;
  race?: string | null;
  vsRace?: string | null;
  perspective?: string | null;
}

/**
 * The config with each build in the pools it fits; `added` counts new
 * entries, `matchups` lists the pools that changed. Opponent captures are
 * never your own builds, so they are skipped.
 *
 * Example: a PvZ build → added to the PvZ pool only.
 */
export function addBuildsToPool(
  raw: unknown,
  builds: ReadonlyArray<PoolBuild>,
): { config: RandomizerConfig; added: number; matchups: MatchupKey[] } {
  let config = sanitizeRandomizerConfig(raw);
  let added = 0;
  const matchups: MatchupKey[] = [];
  for (const matchup of MATCHUPS) {
    const { my, vs } = matchupRaces(matchup);
    let pool = config.matchups[matchup];
    for (const build of builds) {
      if (build.perspective === "opponent" || coerceRace(build.race) !== my) continue;
      const against = coerceVsRace(build.vsRace);
      if (against !== "Any" && against !== vs) continue;
      const id = `custom:${build.slug}`;
      if (pool.builds.some((entry) => entry.id === id)) continue;
      pool = toggleBuild(pool, {
        id,
        name: build.name,
        race: my,
        source: "custom",
        weight: 1,
        ...(my === "Protoss" ? { openingUnits: defaultOpeningUnits(inferGatewayCount(matchup, build.name)) } : {}),
      }, true);
      added += 1;
    }
    if (pool !== config.matchups[matchup]) {
      config = withMatchup(config, matchup, pool);
      matchups.push(matchup);
    }
  }
  return { config, added, matchups };
}
