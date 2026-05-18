import { afterEach, describe, expect, it } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { OpponentGamesTimeline } from "../OpponentGamesTimeline";
import type { PerGameScoutingEnvelope } from "@/components/overlay/types";

afterEach(cleanup);

/**
 * Renders the per-game timeline that powers "How games against this
 * opponent play out". Each envelope here mirrors the API's
 * ``PerGameScoutingEnvelope`` shape one-to-one — same compute backs
 * both the overlay scouting widget and this profile-page renderer,
 * so the per-game compute is already pinned by
 * ``apps/api/__tests__/perGameScouting.test.js``; this file pins the
 * tabbing + per-side rendering behaviours unique to the timeline.
 */

function envelope(
  extra: Partial<PerGameScoutingEnvelope> = {},
): PerGameScoutingEnvelope {
  return {
    gameId: "g_default",
    date: "2026-04-10T00:00:00.000Z",
    map: "Goldenaura LE",
    result: "win",
    durationSec: 720,
    myRace: "Protoss",
    myBuild: "PvZ - 3 Stargate Phoenix",
    oppRace: "Zerg",
    oppName: "WallOfHydra",
    oppStrategy: "Zerg - Brood Lord Macro",
    oppBuildOrder: [
      { name: "SpawningPool", time: 12, category: "building", tier: 1 },
      { name: "RoachWarren", time: 90, category: "building", tier: 1 },
      { name: "HydraliskDen", time: 160, category: "building", tier: 2 },
      { name: "BroodLord", time: 420, category: "unit", tier: 3 },
    ],
    oppTransitions: {
      earlyMidAt: 50,
      midAt: 180,
      midLateAt: 300,
      lateAt: 420,
    },
    oppCompositionByPhase: {
      early: { reached: true, atTime: 25, units: [{ token: "Zergling", count: 6 }] },
      earlyMid: { reached: true, atTime: 115, units: [{ token: "Roach", count: 4 }] },
      mid: { reached: true, atTime: 240, units: [{ token: "Roach", count: 6 }] },
      midLate: { reached: true, atTime: 360, units: [{ token: "Hydralisk", count: 6 }] },
      late: { reached: true, atTime: 510, units: [{ token: "BroodLord", count: 4 }] },
    },
    myBuildOrder: [
      { name: "Nexus", time: 0, category: "building", tier: 1 },
      { name: "Stargate", time: 240, category: "building", tier: 2 },
    ],
    myTransitions: {
      earlyMidAt: 60,
      midAt: 200,
      midLateAt: 320,
      lateAt: 460,
    },
    myCompositionByPhase: {
      early: { reached: true, atTime: 25, units: [{ token: "Probe", count: 12 }] },
      earlyMid: { reached: true, atTime: 115, units: [{ token: "Stalker", count: 3 }] },
      mid: { reached: true, atTime: 240, units: [{ token: "Phoenix", count: 4 }] },
      midLate: { reached: false, atTime: null, units: [] },
      late: { reached: false, atTime: null, units: [] },
    },
    endPhase: "late",
    endReason: "macro_game",
    flags: [],
    ...extra,
  };
}

describe("OpponentGamesTimeline", () => {
  it("renders nothing when there are no envelopes", () => {
    const { container } = render(<OpponentGamesTimeline envelopes={[]} />);
    expect(container.firstChild).toBeNull();
  });

  it("renders one tab per game and a detail card for the active game", () => {
    const games = [
      envelope({ gameId: "g1", durationSec: 600, result: "win" }),
      envelope({ gameId: "g2", durationSec: 450, result: "loss" }),
      envelope({ gameId: "g3", durationSec: 800, result: "win" }),
    ];
    render(<OpponentGamesTimeline envelopes={games} />);
    const tabs = screen.getAllByTestId("opponent-games-tab");
    expect(tabs).toHaveLength(3);
    // Active tab is the newest (index 0).
    expect(tabs[0].getAttribute("data-active")).toBe("true");
    const detail = screen.getByTestId("opponent-game-detail");
    expect(detail.getAttribute("data-game-id")).toBe("g1");
  });

  it("switches the detail card when a different tab is clicked", () => {
    const games = [
      envelope({ gameId: "g1" }),
      envelope({ gameId: "g2" }),
      envelope({ gameId: "g3" }),
    ];
    render(<OpponentGamesTimeline envelopes={games} />);
    const tabs = screen.getAllByTestId("opponent-games-tab");
    fireEvent.click(tabs[2]);
    expect(screen.getByTestId("opponent-game-detail").getAttribute("data-game-id"))
      .toBe("g3");
  });

  it("renders the end-phase + end-reason pills on the detail card", () => {
    render(<OpponentGamesTimeline envelopes={[envelope()]} />);
    const detail = screen.getByTestId("opponent-game-detail");
    expect(detail.textContent).toContain("Late");
    expect(detail.textContent).toContain("Macro game");
  });

  it("renders both opponent and player build-order sections when myBuildOrder is set", () => {
    render(<OpponentGamesTimeline envelopes={[envelope()]} />);
    const detail = screen.getByTestId("opponent-game-detail");
    expect(detail.textContent).toContain("OPPONENT BUILD ORDER");
    expect(detail.textContent).toContain("YOUR BUILD ORDER");
  });

  it("omits the YOUR BUILD ORDER section when the envelope has no my-side data", () => {
    render(
      <OpponentGamesTimeline
        envelopes={[
          envelope({
            myBuildOrder: undefined,
            myCompositionByPhase: undefined,
            myTransitions: undefined,
          }),
        ]}
      />,
    );
    const detail = screen.getByTestId("opponent-game-detail");
    expect(detail.textContent).toContain("OPPONENT BUILD ORDER");
    expect(detail.textContent).not.toContain("YOUR BUILD ORDER");
  });

  it("renders Did not reach for phases the game never crossed", () => {
    const env = envelope({
      oppCompositionByPhase: {
        ...envelope().oppCompositionByPhase,
        midLate: { reached: false, atTime: null, units: [] },
        late: { reached: false, atTime: null, units: [] },
      },
      oppTransitions: { earlyMidAt: 50, midAt: 180, midLateAt: null, lateAt: null },
      endPhase: "mid",
      endReason: "midgame_engagement",
    });
    render(<OpponentGamesTimeline envelopes={[env]} />);
    const phaseCards = screen.getAllByTestId("opponent-game-phase-card");
    const lateCard = phaseCards.find(
      (n) => n.getAttribute("data-phase") === "late",
    );
    expect(lateCard).toBeDefined();
    expect(lateCard?.textContent).toContain("Did not reach");
  });

  it("merges consecutive phases that share the same crossing time into one cell", () => {
    // Classifier collapses mid + midLate + late onto the same crossing
    // when T3 tech / unit floors ratchet the score across multiple
    // thresholds in the same second. The grid must NOT render three
    // identical composition cards in that case — it should merge them
    // into a single cell labelled with the highest reached phase.
    const env = envelope({
      oppTransitions: {
        earlyMidAt: 50,
        midAt: 630,
        midLateAt: 630,
        lateAt: 630,
      },
      oppCompositionByPhase: {
        early: {
          reached: true,
          atTime: 25,
          units: [{ token: "Zergling", count: 6 }],
        },
        earlyMid: {
          reached: true,
          atTime: 340,
          units: [{ token: "Roach", count: 4 }],
        },
        mid: {
          reached: true,
          atTime: 630,
          units: [{ token: "Roach", count: 20 }, { token: "Hydralisk", count: 5 }],
        },
        midLate: {
          reached: true,
          atTime: 630,
          units: [{ token: "Roach", count: 20 }, { token: "Hydralisk", count: 5 }],
        },
        late: {
          reached: true,
          atTime: 700,
          units: [{ token: "Roach", count: 22 }, { token: "BroodLord", count: 7 }],
        },
      },
      durationSec: 770,
    });
    render(<OpponentGamesTimeline envelopes={[env]} />);
    const phaseCards = screen.getAllByTestId("opponent-game-phase-card");
    // The OPPONENT side should now have only 3 cells: early, earlyMid,
    // and one merged mid+midLate+late cell. (Player side has empty
    // transitions so all five phase cards still render for it.)
    const oppCards = phaseCards.filter((n) =>
      n.getAttribute("data-merged-phases")?.split(",").every((p) =>
        ["early", "earlyMid", "mid", "midLate", "late"].includes(p),
      ),
    );
    const merged = oppCards.find(
      (n) => n.getAttribute("data-merged-phases") === "mid,midLate,late",
    );
    expect(merged).toBeDefined();
    expect(merged?.textContent).toContain("transitioned through");
    // The merged cell renders the LATE composition (highest reached
    // phase), not duplicated mid composition.
    expect(merged?.textContent).toContain("22");
  });

  it("renders the WHERE GAMES END distribution bar when finalPhaseDistribution is provided", () => {
    render(
      <OpponentGamesTimeline
        envelopes={[envelope()]}
        finalPhaseDistribution={{
          early: 3,
          earlyMid: 14,
          mid: 0,
          midLate: 0,
          late: 9,
        }}
        sampleSize={{ early: 26, earlyMid: 23, mid: 9, midLate: 9, late: 9 }}
      />,
    );
    const dist = screen.getByLabelText(
      /Phase the game ended in, across all matches/i,
    );
    expect(dist).toBeTruthy();
  });

  it("does not render the legacy median phase timing marker", () => {
    const { container } = render(
      <OpponentGamesTimeline
        envelopes={[envelope()]}
        finalPhaseDistribution={{ early: 0, earlyMid: 0, mid: 0, midLate: 0, late: 1 }}
      />,
    );
    expect(container.textContent).not.toMatch(/MEDIAN PHASE TIMING/i);
    expect(container.textContent).not.toMatch(/median ends here/i);
  });

  it("renders buildings and upgrades when the envelope carries them", () => {
    const env = envelope({
      oppBuildingsByPhase: {
        early: { reached: true, atTime: 25, buildings: [
          { token: "Hatchery", count: 1 },
          { token: "SpawningPool", count: 1 },
        ] },
        earlyMid: { reached: true, atTime: 115, buildings: [
          { token: "Hatchery", count: 2 },
          { token: "RoachWarren", count: 1 },
        ] },
        mid: { reached: true, atTime: 240, buildings: [] },
        midLate: { reached: true, atTime: 360, buildings: [] },
        late: { reached: true, atTime: 510, buildings: [
          { token: "Hive", count: 1 },
          { token: "Hatchery", count: 3 },
        ] },
      },
      oppUpgradesByPhase: {
        early: { reached: true, atTime: 25, upgrades: [] },
        earlyMid: { reached: true, atTime: 115, upgrades: [
          { token: "MetabolicBoost", count: 1 },
        ] },
        mid: { reached: true, atTime: 240, upgrades: [] },
        midLate: { reached: true, atTime: 360, upgrades: [] },
        late: { reached: true, atTime: 510, upgrades: [
          { token: "MetabolicBoost", count: 1 },
          { token: "ZergMissileWeaponsLevel2", count: 2 },
        ] },
      },
    });
    render(<OpponentGamesTimeline envelopes={[env]} />);
    const detail = screen.getByTestId("opponent-game-detail");
    expect(detail.textContent).toContain("BUILDINGS");
    expect(detail.textContent).toContain("UPGRADES");
    // Building chips render via the Icon component which surfaces the
    // token name through aria-label / alt text rather than as a text
    // node, so look it up on the actual DOM rather than textContent.
    const oppPhaseCards = detail.querySelectorAll(
      '[data-testid="opponent-game-phase-card"]',
    );
    // Find the cell whose merged-phases ends in "late".
    const lateLikeCard = Array.from(oppPhaseCards).find((n) =>
      n.getAttribute("data-merged-phases")?.split(",").includes("late"),
    );
    expect(lateLikeCard).toBeDefined();
    const icons = lateLikeCard!.querySelectorAll('img, [role="img"]');
    const altTexts = Array.from(icons).map(
      (n) => n.getAttribute("alt") || n.getAttribute("aria-label") || "",
    );
    expect(altTexts).toContain("Hive");
  });

  it("labels timeline-sourced compositions as 'peak alive'", () => {
    const env = envelope({
      oppCompositionByPhase: {
        early: { reached: true, atTime: 25, units: [
          { token: "Zergling", count: 6 },
        ], source: "timeline" },
        earlyMid: { reached: true, atTime: 115, units: [
          { token: "Roach", count: 4 },
        ], source: "timeline" },
        mid: { reached: true, atTime: 240, units: [
          { token: "Roach", count: 8 },
        ], source: "timeline" },
        midLate: { reached: false, atTime: null, units: [] },
        late: { reached: false, atTime: null, units: [] },
      },
      oppTransitions: { earlyMidAt: 50, midAt: 180, midLateAt: null, lateAt: null },
      endPhase: "mid",
      endReason: "midgame_engagement",
    });
    render(<OpponentGamesTimeline envelopes={[env]} />);
    const detail = screen.getByTestId("opponent-game-detail");
    expect(detail.textContent?.toLowerCase()).toContain("peak alive");
  });

  it("steps through games with ArrowRight / ArrowLeft", () => {
    const games = [
      envelope({ gameId: "g1" }),
      envelope({ gameId: "g2" }),
      envelope({ gameId: "g3" }),
    ];
    render(<OpponentGamesTimeline envelopes={games} />);
    const tablist = screen.getByRole("tablist");
    fireEvent.keyDown(tablist, { key: "ArrowRight" });
    expect(screen.getByTestId("opponent-game-detail").getAttribute("data-game-id"))
      .toBe("g2");
    fireEvent.keyDown(tablist, { key: "ArrowRight" });
    expect(screen.getByTestId("opponent-game-detail").getAttribute("data-game-id"))
      .toBe("g3");
    fireEvent.keyDown(tablist, { key: "ArrowLeft" });
    expect(screen.getByTestId("opponent-game-detail").getAttribute("data-game-id"))
      .toBe("g2");
  });
});
