/**
 * Shared check-in fixtures for the game-page card tests: a pending PvZ
 * game, its build lists for both sides and a replay build order.
 */
import type { GameBuildOrderResponse } from "@/components/analyzer/game/types";
import type { BuildOption, GameIntentState, OpponentIntentState } from "@/lib/buildIntent";

export const BUILD_ORDER: Partial<GameBuildOrderResponse> = {
  my_race: "Protoss",
  opp_race: "Zerg",
  events: [{ time: 30, name: "Gateway", is_building: true }],
  opp_events: [{ time: 40, name: "SpawningPool", is_building: true }],
};

export function option(overrides: Partial<BuildOption>): BuildOption {
  return {
    key: "pvz-stargate",
    name: "PvZ - Stargate",
    slug: null,
    source: "catalog",
    games: 3,
    wins: 2,
    losses: 1,
    checkins: 0,
    lastPlayedAt: null,
    inRandomizer: false,
    group: "yours",
    ...overrides,
  };
}

export const OPTIONS = [
  option({ key: "pvz-2-stargate-phoenix", name: "PvZ - 2 Stargate Phoenix" }),
  option({ key: "custom:dt-3-gate", name: "DT into 3 Gate", slug: "dt-3-gate", source: "custom" }),
  option({ key: "pvz-blink-stalkers", name: "PvZ - Blink Stalkers", group: "all" }),
];

export function intent(overrides: Partial<GameIntentState> = {}): GameIntentState {
  return {
    gameId: "g1",
    matchup: "PvZ",
    myRace: "Protoss",
    oppRace: "Zerg",
    result: "Victory",
    date: "2026-10-22T18:00:00.000Z",
    durationSec: 842,
    map: "Ephemeron",
    oppName: "Foe",
    eligible: true,
    ineligibleReason: null,
    status: "pending",
    applied: false,
    build: null,
    suggestion: {
      key: "pvz-2-stargate-phoenix",
      name: "PvZ - 2 Stargate Phoenix",
      slug: null,
      source: "catalog",
      reason: "randomizer",
      passedRules: null,
      ruleCount: null,
    },
    randomizer: {
      key: "pvz-2-stargate-phoenix",
      name: "PvZ - 2 Stargate Phoenix",
      slug: null,
      source: "catalog",
    },
    randomizerDeviated: false,
    detected: { name: "PvZ - Macro Transition (Unclassified)", slug: null, key: null },
    executed: false,
    notes: "",
    origin: null,
    via: null,
    confirmedAt: null,
    updatedAt: null,
    prefs: { enabled: true, askAtLoading: true, askAfterGame: true },
    options: OPTIONS,
    usualKey: "custom:dt-3-gate",
    ...overrides,
  };
}

export function confirmedResponse(key: string, name: string, notes = ""): GameIntentState {
  const { options: _options, usualKey: _usualKey, ...rest } = intent({
    status: "confirmed",
    applied: true,
    build: { key, name, slug: null, source: "catalog" },
    notes,
  });
  return rest;
}

export const OPP_OPTIONS = [
  option({ key: "zerg-12-pool", name: "Zerg - 12 Pool", games: 4, wins: 3, losses: 1 }),
  option({ key: "custom:ling-flood", name: "Ling Flood", slug: "ling-flood", source: "custom" }),
  option({ key: "zvp-ling-bane-bust", name: "ZvP - Ling Bane Bust", group: "all", games: 0, wins: 0, losses: 0 }),
];

export function opponentState(overrides: Partial<OpponentIntentState> = {}): OpponentIntentState {
  return {
    label: "Zerg - 12 Pool",
    status: "none",
    build: null,
    applied: false,
    detected: { name: "Zerg - 12 Pool", slug: null, key: "zerg-12-pool" },
    suggestion: null,
    executed: null,
    options: OPP_OPTIONS,
    ...overrides,
  };
}

export const CORRECTED = opponentState({
  label: "Ling Flood",
  status: "confirmed",
  applied: true,
  build: { key: "custom:ling-flood", name: "Ling Flood", slug: "ling-flood", source: "custom" },
});
