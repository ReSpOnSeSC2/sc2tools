/**
 * Protoss rules for the opening-unit draw: how many Gateways a build opens
 * with, and the all-four-units default. Unit names and icons live in
 * `openingUnits.ts`; the Terran and Zerg rules in `openingUnitPools.ts`.
 */
import {
  GATEWAY_UNIT_IDS,
  type GatewayCount,
  type MatchupKey,
  type OpeningUnitsConfig,
} from "./types";

/**
 * Prefer an explicit "1 Gate" / "2-Gate" build-name signal, then use the
 * matchup convention requested by the streamer: PvP defaults to two; PvT and
 * PvZ default to one.
 */
export function inferGatewayCount(
  matchup: MatchupKey,
  buildName: string,
): GatewayCount {
  const explicit = /(?:^|\b)([12])\s*[- ]?\s*gate(?:way)?s?\b/i.exec(buildName);
  if (explicit?.[1] === "2") return 2;
  if (explicit?.[1] === "1") return 1;
  return matchup === "PvP" ? 2 : 1;
}

/** Every Gateway unit at equal odds, drawn `gateCount` times. */
export function defaultGatewayUnits(
  gateCount: GatewayCount,
): OpeningUnitsConfig {
  return {
    gateCount,
    useCustomWeights: false,
    units: GATEWAY_UNIT_IDS.map((id) => ({ id, weight: 1 })),
  };
}
