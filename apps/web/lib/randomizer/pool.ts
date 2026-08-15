/**
 * Candidate-pool assembly for the randomizer settings UI.
 *
 * A matchup's selectable builds are the union of:
 *   • the bundled BUILD_DEFINITIONS catalog filtered to that matchup
 *     (matchup-specific rules + the race-generic ones), and
 *   • the streamer's own custom builds whose race / vsRace fit.
 *
 * Catalog ids are the definition slug; custom ids are prefixed
 * `custom:` so the two namespaces never collide inside one pool.
 */
import {
  BUILD_DEFINITIONS,
  filterDefinitions,
  type StrategyMatchup,
} from "@/lib/build-definitions";
import type { Race } from "@/lib/race";
import { coerceRace, coerceVsRace } from "@/lib/race";
import type { CustomBuild } from "@/components/builds/types";
import { matchupRaces, type MatchupKey } from "./types";
import { inferGatewayCount } from "./gatewayUnits";

export interface PoolCandidate {
  id: string;
  name: string;
  race: Race;
  source: "catalog" | "custom";
  /** Suggested opening production count; editable after selection. */
  suggestedGateCount: 1 | 2;
}

/** Catalog builds available for a matchup (matchup-specific + generic). */
export function catalogCandidates(m: MatchupKey): PoolCandidate[] {
  const { my } = matchupRaces(m);
  const defs = filterDefinitions(
    BUILD_DEFINITIONS,
    "",
    my,
    m as StrategyMatchup,
  );
  return defs.map((d) => ({
    id: d.id,
    name: d.name,
    race: d.race,
    source: "catalog" as const,
    suggestedGateCount: inferGatewayCount(m, d.name),
  }));
}

/** Custom builds whose race + vsRace fit a matchup. */
export function customCandidates(
  m: MatchupKey,
  customBuilds: ReadonlyArray<CustomBuild>,
): PoolCandidate[] {
  const { my, vs } = matchupRaces(m);
  return customBuilds
    .filter((b) => {
      const race = coerceRace(b.race);
      if (race !== my) return false;
      const against = coerceVsRace(b.vsRace);
      return against === "Any" || against === vs;
    })
    .map((b) => ({
      id: `custom:${b.slug}`,
      name: b.name,
      race: coerceRace(b.race),
      source: "custom" as const,
      suggestedGateCount: inferGatewayCount(m, b.name),
    }));
}

/** Full selectable pool for a matchup — catalog first, then custom. */
export function candidatePool(
  m: MatchupKey,
  customBuilds: ReadonlyArray<CustomBuild>,
): PoolCandidate[] {
  const seen = new Set<string>();
  const out: PoolCandidate[] = [];
  for (const c of [...catalogCandidates(m), ...customCandidates(m, customBuilds)]) {
    if (seen.has(c.id)) continue;
    seen.add(c.id);
    out.push(c);
  }
  return out;
}
