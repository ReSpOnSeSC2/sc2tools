import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render } from "@testing-library/react";
import { GameBattleReport } from "../GameBattleReport";
import type { GameIntentState } from "@/lib/buildIntent";
import type { GameSummary } from "@/components/analyzer/game/types";
vi.mock("@/components/help/LazyHelpLink", () => ({ LazyHelpLink: () => <span>How this is written</span> }));
const game: GameSummary = { gameId: "owned", myRace: "Protoss", myBuild: "Summary opener", durationSec: 600, result: "Victory", opponent: { displayName: "Replay rival", race: "Zerg", strategy: "Summary opponent opener" } };
const intent: Pick<GameIntentState, "gameId" | "status" | "applied" | "build" | "detected" | "opponent"> = {
  gameId: "owned", status: "confirmed", applied: true,
  build: { key: "custom:mine", source: "custom", slug: null, name: "0:00 Pressure" },
  detected: { name: "Replay classifier opener", slug: null, key: null },
  opponent: { label: "0:00 opponent correction", status: "confirmed", applied: true,
    build: { key: "custom:theirs", source: "custom", slug: null, name: "0:00 opponent correction" },
    detected: { name: "Replay opponent classifier", slug: null, key: null }, suggestion: null, executed: null },
};
afterEach(() => { cleanup(); });

describe("game-page report inputs", () => {
  it("uses authoritative replay races and distinguishes a checked plan/correction from the recorded classifiers", () => {
    const view = render(<GameBattleReport game={game} intent={intent} breakdown={{ ok: true, stats_events: [{ time: 60, food_workers: 30 }] }} buildOrders={{ events: [{ time: 120, name: "RoachWarren", category: "building" }], opp_events: [], my_race: "Zerg", opp_race: "Terran" }} onSeek={vi.fn()} />);
    expect(view.container.textContent).toContain("Zerg versus Terran");
    expect(view.container.textContent).toContain("checked-in plan was 0:00 Pressure");
    expect(view.container.textContent).toContain("replay classifier named Replay classifier opener");
    expect(view.container.textContent).toContain("Replay opponent classifier");
    expect(view.container.textContent).not.toContain("replay-classified opening was 0:00 opponent correction");
    view.rerender(<GameBattleReport game={game} intent={{ ...intent, opponent: { ...intent.opponent!, detected: null } }} onSeek={vi.fn()} />);
    expect(view.container.textContent).toContain("corrected opponent label was 0:00 opponent correction");
    expect(view.container.textContent).not.toContain("opponent's replay-classified opening");
  });

  it("clears stale summary flags when the same game's authoritative check-in is no longer applied, and ignores another game's intent", () => {
    const view = render(<GameBattleReport game={{ ...game, myBuild: "Old plan", buildPlanned: true }} intent={{ ...intent, status: "none", applied: false }} onSeek={vi.fn()} />);
    expect(view.container.textContent).toContain("Replay classifier opener"); expect(view.container.textContent).not.toContain("checked-in plan");
    view.rerender(<GameBattleReport game={game} intent={{ ...intent, gameId: "different-game" }} onSeek={vi.fn()} />);
    expect(view.container.textContent).toContain("Summary opener"); expect(view.container.textContent).not.toContain("0:00 Pressure");
  });
});
