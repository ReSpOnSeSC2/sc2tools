import { describe, expect, it } from "vitest";
import { render, within } from "@testing-library/react";
import { ScoutingWidget } from "../ScoutingWidget";
import type { LiveGameEnvelope, PerGameScoutingEnvelope } from "../../types";

function scoutingGame(extra: Partial<PerGameScoutingEnvelope> = {}): PerGameScoutingEnvelope {
  const emptyPhase = { reached: false, atTime: null, units: [] };
  return {
    gameId: "last-replay",
    date: "2026-10-21T12:00:00Z",
    map: "Goldenaura LE",
    result: "win",
    durationSec: 600,
    myRace: "Protoss",
    myBuild: "Blink opener",
    oppName: "Opponent",
    oppRace: "Zerg",
    oppStrategy: "Hydra macro",
    myTechMilestones: [
      { name: "Gateway", timeSec: 50, kind: "building", timing: "started" },
      { name: "BlinkTech", timeSec: 260, kind: "upgrade", timing: "completed" },
    ],
    oppTechMilestones: [
      { name: "Lair", timeSec: 238, kind: "building", timing: "completed" },
      { name: "Hydralisk", timeSec: 320, kind: "unit", timing: "completed" },
    ],
    oppBuildOrder: [],
    oppTransitions: { earlyMidAt: null, midAt: null, midLateAt: null, lateAt: null },
    oppCompositionByPhase: { early: emptyPhase, earlyMid: emptyPhase, mid: emptyPhase, midLate: emptyPhase, late: emptyPhase },
    endPhase: "mid",
    endReason: "midgame_engagement",
    flags: [],
    ...extra,
  };
}

function liveGame(game: PerGameScoutingEnvelope): LiveGameEnvelope {
  return {
    type: "liveGameState",
    phase: "match_started",
    capturedAt: 0,
    opponent: { name: "Opponent", race: "Zerg" },
    streamerHistory: { oppName: "Opponent", last5GamesScouting: [game] },
  };
}

describe("scouting widget tech timeline", () => {
  it("shows both build labels and recorded milestone timings with SC2 icons", () => {
    const { container } = render(<ScoutingWidget live={null} liveGame={liveGame(scoutingGame())} />);
    const timeline = within(container).getByRole("region", { name: "Last game tech timeline" });
    const own = within(timeline).getByLabelText("YOU tech milestones");
    const opponent = within(timeline).getByLabelText("OPP tech milestones");
    expect(own.textContent).toContain("Blink opener");
    expect(own.textContent).toContain("0:50");
    expect(own.textContent).toContain("Gateway started");
    expect(own.textContent).toContain("4:20");
    expect(own.textContent).toContain("Blink completed");
    expect(opponent.textContent).toContain("Hydra macro");
    expect(opponent.textContent).toContain("3:58");
    expect(opponent.textContent).toContain("Lair completed");
    expect(opponent.textContent).toContain("5:20");
    expect(own.querySelector('img[src*="gateway.png"]')).not.toBeNull();
    expect(opponent.querySelector('img[src*="hydralisk.png"]')).not.toBeNull();
  });

  it("uses in-game upgrade labels while preserving raw names for icons", () => {
    const game = scoutingGame({ myTechMilestones: [
      { name: "zerglingmovementspeed", timeSec: 180, kind: "upgrade", timing: "completed" },
      { name: "BlinkTech", timeSec: 240, kind: "upgrade", timing: "completed" },
      { name: "ShieldWall", timeSec: 300, kind: "upgrade", timing: "completed" },
      { name: "PunisherGrenades", timeSec: 360, kind: "upgrade", timing: "completed" },
    ] });
    const { container } = render(<ScoutingWidget live={null} liveGame={liveGame(game)} />);
    const own = within(container).getByLabelText("YOU tech milestones");
    expect(own.textContent).toContain("Metabolic Boost completed");
    expect(own.textContent).toContain("Blink completed");
    expect(own.textContent).toContain("Combat Shield completed");
    expect(own.textContent).toContain("Concussive Shells completed");
    expect(own.textContent).not.toContain("zerglingmovementspeed");
    expect(own.querySelector('img[src*="metabolicboost.png"]')).not.toBeNull();
    expect(own.querySelector('img[src*="combatshield.png"]')).not.toBeNull();
    expect(own.querySelector('img[src*="concussive.png"]')).not.toBeNull();
    expect(game.myTechMilestones.map((milestone) => milestone.name)).toEqual([
      "zerglingmovementspeed", "BlinkTech", "ShieldWall", "PunisherGrenades",
    ]);
  });

  it("does not invent timings from legacy phase snapshots or build names", () => {
    const { myTechMilestones: _own, oppTechMilestones: _opponent, ...legacy } = scoutingGame();
    const { container } = render(<ScoutingWidget live={null} liveGame={liveGame(legacy as PerGameScoutingEnvelope)} />);
    expect(within(container).getAllByText("Tech timings unavailable")).toHaveLength(2);
    expect(container.textContent).not.toContain("0:50");
  });

  it("preserves early and late milestones while identifying omitted middle steps", () => {
    const names = ["Gateway", "CyberneticsCore", "Nexus", "TwilightCouncil", "RoboticsFacility", "Forge", "RoboticsBay", "DarkShrine", "Stargate", "FleetBeacon"];
    const game = scoutingGame({ myTechMilestones: names.map((name, index) => ({
      name, timeSec: index * 45 + 30, kind: "building", timing: "started",
    })) });
    const { container } = render(<ScoutingWidget live={null} liveGame={liveGame(game)} />);
    const own = within(container).getByLabelText("YOU tech milestones");
    expect(own.textContent).toContain("Gateway");
    expect(own.textContent).toContain("Fleet Beacon");
    expect(own.textContent).not.toContain("Forge");
    expect(own.textContent).toContain("2 intermediate steps omitted");
  });

  it("keeps the timeline absent when there is no prior replay", () => {
    const game = liveGame(scoutingGame());
    game.streamerHistory = { oppName: "Opponent" };
    const { container } = render(<ScoutingWidget live={null} liveGame={game} />);
    expect(within(container).queryByRole("region", { name: "Last game tech timeline" })).toBeNull();
  });
});
