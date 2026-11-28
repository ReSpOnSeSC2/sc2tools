/**
 * Which opening units each matchup draws from, and a build's default unit
 * draw. Like the build pools, every matchup keeps its own list:
 *
 * - Protoss draws its four Gateway units in every matchup, as it always has.
 * - A Terran or Zerg matchup draws the units its own pre-made builds are
 *   named for (`build-definitions.generated.json`, the catalog its build
 *   pool offers), read the way the icon registry reads unit names ("Ling",
 *   "Tank", "Widow Mine"), keeping the units a single production structure
 *   makes (`unitTechPrerequisites` in `apps/api/src/config/presetCatalog.json`;
 *   Thor, Hellbat and Battlecruiser need two). `__tests__/openingUnitPools.test.ts`
 *   derives every list again from those two files and fails when one drifts.
 *
 * Settings panel and "Add to randomizer pool" only: the overlay draws from
 * the settings a config already stores.
 */
import { iconKindOf, getIconPath } from "@/lib/sc2-icons";
import { defaultGatewayUnits, inferGatewayCount } from "./gatewayUnits";
import { openingUnitMeta } from "./openingUnits";
import {
  GATEWAY_UNIT_IDS,
  playedRace,
  type GatewayCount,
  type MatchupKey,
  type OpeningUnitId,
  type OpeningUnitsConfig,
} from "./types";

export const MATCHUP_UNIT_POOLS: Readonly<Record<MatchupKey, readonly OpeningUnitId[]>> = {
  PvP: GATEWAY_UNIT_IDS,
  PvT: GATEWAY_UNIT_IDS,
  PvZ: GATEWAY_UNIT_IDS,
  TvP: ["marine", "reaper", "marauder", "widowmine", "siegetank", "cyclone", "banshee"],
  TvT: ["marine", "reaper", "marauder", "siegetank", "cyclone", "viking", "banshee", "raven"],
  TvZ: ["marine", "reaper", "hellion", "widowmine", "liberator", "banshee"],
  ZvP: ["zergling", "baneling", "roach", "ravager", "hydralisk", "lurker", "mutalisk"],
  ZvT: ["zergling", "queen", "baneling", "roach", "ravager", "hydralisk", "lurker", "mutalisk"],
  ZvZ: ["zergling", "baneling", "roach", "ravager", "mutalisk"],
};

/** The icon registry's unit for one word of a build name ("Ling" → zergling). */
export function unitIconId(word: string): string | null {
  for (const form of [word, word.replace(/s$/i, ""), word.replace(/es$/i, "")]) {
    if (!form || iconKindOf(form) !== "unit") continue;
    const path = getIconPath(form, "unit");
    if (path) return path.slice(path.lastIndexOf("/") + 1, -".png".length);
  }
  return null;
}

/**
 * Every unit a name names, in order, as icon ids. Two words are read
 * together first so "Widow Mine" and "Siege Tank" stay one unit.
 */
export function unitIconIdsIn(name: string): string[] {
  const words = name.split(/[^A-Za-z]+/).filter(Boolean);
  const found: string[] = [];
  for (let index = 0; index < words.length; index += 1) {
    const pair = index + 1 < words.length ? unitIconId(words[index] + words[index + 1]) : null;
    const unit = pair ?? unitIconId(words[index]);
    if (pair) index += 1;
    if (unit && !found.includes(unit)) found.push(unit);
  }
  return found;
}

/** The units of `matchup`'s pool that `buildName` names, in canonical order. */
function poolUnitsNamedIn(matchup: MatchupKey, buildName: string): OpeningUnitId[] {
  const named = new Set(unitIconIdsIn(buildName));
  return MATCHUP_UNIT_POOLS[matchup].filter((id) => named.has(id));
}

function equalOdds(units: readonly OpeningUnitId[], gateCount: GatewayCount): OpeningUnitsConfig {
  return { gateCount, useCustomWeights: false, units: units.map((id) => ({ id, weight: 1 })) };
}

/**
 * A new pool entry's unit draw, from its own name. Protoss counts its
 * Gateways (`inferGatewayCount`). Terran and Zerg draw from the units the
 * name names, or the whole matchup list when it names none, and draw two
 * when those units come from two structures (a two-building opener such
 * as "Reaper Hellion": Barracks and Factory).
 *
 * Example: ("TvZ", "TvZ - Reaper Hellion Expand") → reaper and hellion, two picks.
 */
export function defaultBuildOpeningUnits(matchup: MatchupKey, buildName: string): OpeningUnitsConfig {
  if (playedRace(matchup) === "Protoss") return defaultGatewayUnits(inferGatewayCount(matchup, buildName));
  const named = poolUnitsNamedIn(matchup, buildName);
  const buildings = new Set(named.map((id) => openingUnitMeta(id).building));
  return equalOdds(named.length > 0 ? named : MATCHUP_UNIT_POOLS[matchup], buildings.size >= 2 ? 2 : 1);
}

/**
 * The matchup's own unit draw before the streamer edits it: every unit of
 * its list at equal odds, two for PvP (the Gateway draw's convention) and
 * one elsewhere.
 */
export function defaultMatchupUnits(matchup: MatchupKey): OpeningUnitsConfig {
  return equalOdds(MATCHUP_UNIT_POOLS[matchup], inferGatewayCount(matchup, ""));
}
