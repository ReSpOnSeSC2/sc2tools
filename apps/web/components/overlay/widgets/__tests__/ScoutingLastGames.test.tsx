import { describe, expect, it } from "vitest";
import { render } from "@testing-library/react";
import { ScoutingLastGames } from "../ScoutingLastGames";
import { ScoutingWidget } from "../ScoutingWidget";
import type {
  LiveGameEnvelope,
  PerGameScoutingEnvelope,
} from "../../types";

/**
 * Pins for the per-game scouting block. The envelopes here mirror
 * the API's ``PerGameScoutingEnvelope`` shape exactly — the API
 * tests in ``apps/api/__tests__/perGameScouting.test.js`` cover the
 * compute path; this file covers the renderer.
 */

function baseEnvelope(extra: Partial<PerGameScoutingEnvelope> = {}): PerGameScoutingEnvelope {
  return {
    gameId: "g_default",
    date: "2026-04-10T00:00:00.000Z",
    map: "Goldenaura LE",
    result: "win",
    durationSec: 600,
    myRace: "Protoss",
    myBuild: "PvZ - 3 Stargate Phoenix",
    oppRace: "Zerg",
    oppName: "WallOfHydra",
    oppStrategy: "Zerg - Brood Lord Macro",
    oppBuildOrder: [
      { name: "SpawningPool", time: 12, category: "building", tier: 1 },
      { name: "RoachWarren", time: 90, category: "building", tier: 1 },
      { name: "HydraliskDen", time: 160, category: "building", tier: 2 },
      { name: "Hive", time: 280, category: "building", tier: 3 },
      { name: "BroodLord", time: 420, category: "unit", tier: 3 },
    ],
    oppTransitions: {
      earlyMidAt: 50,
      midAt: 180,
      midLateAt: 300,
      lateAt: 420,
    },
    oppCompositionByPhase: {
      early: { reached: true, atTime: 25, units: [
        { token: "Zergling", count: 6 },
      ] },
      earlyMid: { reached: true, atTime: 115, units: [
        { token: "Roach", count: 4 },
      ] },
      mid: { reached: true, atTime: 240, units: [
        { token: "Roach", count: 6 },
        { token: "Hydralisk", count: 4 },
      ] },
      midLate: { reached: true, atTime: 360, units: [
        { token: "Hydralisk", count: 6 },
        { token: "Corruptor", count: 4 },
      ] },
      late: { reached: true, atTime: 510, units: [
        { token: "BroodLord", count: 4 },
        { token: "Corruptor", count: 6 },
      ] },
    },
    endPhase: "late",
    endReason: "macro_game",
    flags: [],
    ...extra,
  };
}

function envelope(extra: Partial<LiveGameEnvelope> = {}): LiveGameEnvelope {
  return {
    type: "liveGameState",
    phase: "match_started",
    capturedAt: 0,
    ...extra,
  };
}

describe("ScoutingLastGames", () => {
  it("renders one row per envelope with the end-phase + end-reason pills", () => {
    const env = baseEnvelope();
    const { container } = render(
      <ScoutingLastGames envelopes={[env]} />,
    );
    const rows = container.querySelectorAll(
      '[data-testid="scouting-last-game"]',
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].getAttribute("data-game-id")).toBe("g_default");
    expect(container.textContent).toContain("Late");
    expect(container.textContent).toContain("Macro game");
  });

  it("shows N of 5 badge when fewer than 5 envelopes are present", () => {
    const envs: PerGameScoutingEnvelope[] = [
      baseEnvelope({ gameId: "g1" }),
      baseEnvelope({ gameId: "g2" }),
      baseEnvelope({ gameId: "g3" }),
    ];
    const { container } = render(
      <ScoutingLastGames envelopes={envs} />,
    );
    expect(container.textContent).toContain("3 of 5");
  });

  it("hides the N-of-5 badge when exactly 5 envelopes are present", () => {
    const envs: PerGameScoutingEnvelope[] = Array.from({ length: 5 })
      .map((_, i) => baseEnvelope({ gameId: `g${i}` }));
    const { container } = render(
      <ScoutingLastGames envelopes={envs} />,
    );
    expect(container.textContent).not.toContain("of 5");
  });

  it("phases the game didn't reach render as 'Did not reach', not blank", () => {
    const env = baseEnvelope({
      endPhase: "earlyMid",
      endReason: "midgame_engagement",
      oppCompositionByPhase: {
        early: { reached: true, atTime: 25, units: [
          { token: "Zergling", count: 6 },
        ] },
        earlyMid: { reached: true, atTime: 115, units: [
          { token: "Roach", count: 4 },
        ] },
        mid: { reached: false, atTime: null, units: [] },
        midLate: { reached: false, atTime: null, units: [] },
        late: { reached: false, atTime: null, units: [] },
      },
    });
    const { container } = render(
      <ScoutingLastGames envelopes={[env]} />,
    );
    const placeholders = container.querySelectorAll(
      '[data-testid="scouting-composition-did-not-reach"]',
    );
    expect(placeholders.length).toBeGreaterThan(0);
  });

  it("renders the composition unavailable badge when unit_timeline_missing flag is set", () => {
    const env = baseEnvelope({ flags: ["unit_timeline_missing"] });
    const { container } = render(
      <ScoutingLastGames envelopes={[env]} />,
    );
    expect(
      container.querySelector(
        '[data-testid="scouting-composition-unavailable"]',
      ),
    ).not.toBeNull();
    expect(container.textContent).toContain("Composition data unavailable");
    // The composition strip itself is NOT rendered alongside.
    expect(
      container.querySelector('[data-testid="scouting-composition-strip"]'),
    ).toBeNull();
  });

  it("renders the build-order unavailable badge when opp_buildlog_missing flag is set", () => {
    const env = baseEnvelope({
      flags: ["opp_buildlog_missing"],
      oppBuildOrder: [],
    });
    const { container } = render(
      <ScoutingLastGames envelopes={[env]} />,
    );
    expect(
      container.querySelector(
        '[data-testid="scouting-build-order-unavailable"]',
      ),
    ).not.toBeNull();
  });

  it("composition cards surface peak-alive counts from the envelope without re-splitting variants", () => {
    // The API ships canonical unit tokens with PEAK ALIVE counts per
    // phase. The overlay's mergeBucket aggregates across the
    // mid/late phases inside one card by taking the MAX per token,
    // which (because the server already merged variants) preserves
    // the peak count rather than splitting it. This test pins that
    // a 10-Carrier peak surfaces as "10" on the strip — not split
    // into "Carrier 7" + "Carrier 3" or capped at a midpoint dip.
    const env = baseEnvelope({
      endPhase: "late",
      endReason: "macro_game",
      oppCompositionByPhase: {
        early: { reached: true, atTime: 25, units: [{ token: "Zergling", count: 6 }] },
        earlyMid: { reached: true, atTime: 115, units: [{ token: "Roach", count: 4 }] },
        mid: { reached: true, atTime: 240, units: [
          { token: "Roach", count: 8 },
          { token: "Hydralisk", count: 6 },
        ] },
        midLate: { reached: true, atTime: 360, units: [
          { token: "BroodLord", count: 4 },
          { token: "Corruptor", count: 6 },
        ] },
        late: { reached: true, atTime: 510, units: [
          { token: "BroodLord", count: 8 },
          { token: "Corruptor", count: 10 },
        ] },
      },
    });
    const { container } = render(
      <ScoutingLastGames envelopes={[env]} />,
    );
    const compositionCards = container.querySelectorAll(
      '[data-testid="scouting-composition-card"]',
    );
    // Three cards: Early/Mid · Mid · Mid/Late+ (the mergeBucket grouping).
    expect(compositionCards.length).toBe(3);
    const midLatePlus = Array.from(compositionCards).find(
      (n) => n.getAttribute("data-phase") === "Mid/Late+",
    );
    expect(midLatePlus).toBeDefined();
    // Mid/Late+ bucket merges midLate (BroodLord 4 / Corruptor 6) +
    // late (BroodLord 8 / Corruptor 10) by taking the MAX per token →
    // BroodLord 8, Corruptor 10. Both peak counts survive.
    expect(midLatePlus?.textContent).toContain("8");
    expect(midLatePlus?.textContent).toContain("10");
  });

  it("renders the build-order strip with real timestamps from real events", () => {
    const env = baseEnvelope();
    const { container } = render(
      <ScoutingLastGames envelopes={[env]} />,
    );
    const strip = container.querySelector(
      '[data-testid="scouting-build-order-strip"]',
    );
    expect(strip).not.toBeNull();
    // Real timestamps surface as "m:ss" tokens — pick a few we know.
    expect(strip?.textContent).toContain("0:12");
    expect(strip?.textContent).toContain("4:40");
    expect(strip?.textContent).toContain("7:00");
  });

  it("renders the 'Outcome unclear' chip when endReason is unknown", () => {
    const env = baseEnvelope({
      endPhase: "mid",
      endReason: "unknown",
    });
    const { container } = render(
      <ScoutingLastGames envelopes={[env]} />,
    );
    expect(container.textContent).toContain("Outcome unclear");
  });
});

describe("ScoutingWidget — last5GamesScouting integration", () => {
  it("renders the new ScoutingLastGames block when streamerHistory has last5GamesScouting", () => {
    const env = envelope({
      phase: "match_started",
      opponent: { name: "WallOfHydra", race: "Zerg" },
      streamerHistory: {
        oppName: "WallOfHydra",
        oppRace: "Zerg",
        myRace: "Protoss",
        matchup: "PvZ",
        headToHead: { wins: 2, losses: 1 },
        last5GamesScouting: [baseEnvelope({ gameId: "g_inline" })],
      },
    });
    const { container } = render(
      <ScoutingWidget live={null} liveGame={env} />,
    );
    expect(
      container.querySelector('[data-testid="scouting-last-games"]'),
    ).not.toBeNull();
    const row = container.querySelector(
      '[data-testid="scouting-last-game"]',
    );
    expect(row?.getAttribute("data-game-id")).toBe("g_inline");
  });

  it("removes the legacy OpponentPhases markup even when last5GamesScouting is empty", () => {
    const env = envelope({
      phase: "match_started",
      opponent: { name: "WallOfHydra", race: "Zerg" },
      streamerHistory: {
        oppName: "WallOfHydra",
        oppRace: "Zerg",
        headToHead: { wins: 2, losses: 1 },
        last5GamesScouting: [],
      },
    });
    const { container } = render(
      <ScoutingWidget live={null} liveGame={env} />,
    );
    expect(
      container.querySelector('[data-testid="opponent-phase-strip"]'),
    ).toBeNull();
    expect(container.textContent).not.toContain("Usually reaches");
  });
});
