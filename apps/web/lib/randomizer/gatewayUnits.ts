/**
 * Fixed Protoss Gateway-unit roster and defaults for the second-stage
 * randomizer. Persisted configs store stable lowercase ids; renderers resolve
 * the real shipped SC2 icon through the shared icon registry.
 */
import { getIconPath } from "@/lib/sc2-icons";
import {
  GATEWAY_UNIT_IDS,
  type GatewayCount,
  type GatewayUnitId,
  type MatchupKey,
  type OpeningUnitsConfig,
} from "./types";

export interface GatewayUnitMeta {
  id: GatewayUnitId;
  name: string;
  iconPath: string;
}

const UNIT_NAMES: Record<GatewayUnitId, string> = {
  zealot: "Zealot",
  stalker: "Stalker",
  sentry: "Sentry",
  adept: "Adept",
};

export const GATEWAY_UNITS: ReadonlyArray<GatewayUnitMeta> =
  GATEWAY_UNIT_IDS.map((id) => {
    const name = UNIT_NAMES[id];
    const iconPath = getIconPath(name, "unit");
    if (!iconPath) {
      throw new Error(`Missing SC2 unit icon for ${name}`);
    }
    return { id, name, iconPath };
  });

const GATEWAY_UNIT_ID_SET = new Set<string>(GATEWAY_UNIT_IDS);

export function isGatewayUnitId(value: unknown): value is GatewayUnitId {
  return typeof value === "string" && GATEWAY_UNIT_ID_SET.has(value);
}

export function gatewayUnitMeta(id: GatewayUnitId): GatewayUnitMeta {
  return GATEWAY_UNITS.find((unit) => unit.id === id) as GatewayUnitMeta;
}

/**
 * Prefer an explicit "1 Gate" / "2-Gate" build-name signal, then use the
 * matchup convention requested by the streamer: PvP defaults to two; PvT and
 * PvZ default to one. Non-Protoss matchups fall back to one and never roll.
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

export function defaultOpeningUnits(
  gateCount: GatewayCount,
): OpeningUnitsConfig {
  return {
    gateCount,
    useCustomWeights: false,
    units: GATEWAY_UNIT_IDS.map((id) => ({ id, weight: 1 })),
  };
}

export function defaultOpeningUnitsForBuild(
  matchup: MatchupKey,
  buildName: string,
): OpeningUnitsConfig {
  return defaultOpeningUnits(inferGatewayCount(matchup, buildName));
}
