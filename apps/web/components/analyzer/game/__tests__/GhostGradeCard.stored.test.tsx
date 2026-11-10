import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import type { GhostBuildConfig, GhostTarget } from "@/lib/ghostBuild";

const state = vi.hoisted(() => ({ paths: [] as string[], record: null as unknown, hasConfig: true, config: { v: 2, slots: {} } as GhostBuildConfig }));
vi.mock("@/lib/useGhostPractice", () => ({
  useGhostPractice: () => ({ owner: "o", config: state.config, hasConfig: state.hasConfig, saving: false, loading: false, offline: false, error: null, readError: null, assign: vi.fn() }),
}));
vi.mock("@/lib/clientApi", () => ({
  useApi: (path: string | null) => {
    if (path) state.paths.push(path);
    return { data: path ? { practice: state.record } : undefined, error: undefined, mutate: vi.fn() };
  },
}));

import { GhostGradeCard } from "../GhostGradeContent";

const TODAY: GhostTarget = { v: 1, name: "Today's opener", steps: [{ supply: null, t: 17, name: "Pylon" }, { supply: null, t: 40, name: "Gateway" }] };
const LOG = ["[0:17] Pylon", "[0:40] Gateway"];

afterEach(() => { cleanup(); state.paths = []; state.record = null; state.hasConfig = true; state.config = { v: 2, slots: {} }; });

describe("GhostGradeCard prefers the grade stored at upload", () => {
  it("shows the stored grade against the target armed when the game was played", () => {
    state.config = { v: 2, slots: { PvT: TODAY } };
    state.record = {
      targetHash: "0123456789abcdef", targetName: "Last week's opener", matchup: "PvT", grade: "C", matched: 2, total: 3,
      avgDrift: 21, maxDrift: 40, firstDivergence: { i: 2, name: "TwilightCouncil", expectedT: 95, actualT: null },
      worstSteps: [{ i: 2, name: "TwilightCouncil", d: null }, { i: 1, name: "Gateway", d: 40 }], via: "ingest", gradedAt: "2026-11-01T00:00:00Z",
    };
    render(<GhostGradeCard gameId="g 1" buildLog={LOG} myRace="Protoss" opponentRace="Terran" />);
    expect(state.paths).toEqual(["/v1/practice/games/g%201"]);
    expect(screen.getByLabelText("Grade C")).toBeTruthy();
    expect(screen.getByText("vs Last week's opener")).toBeTruthy();
    expect(screen.getByText("2/3")).toBeTruthy();
    expect(screen.getByRole("list", { name: "Steps furthest off the plan" }).textContent).toContain("TwilightCouncilmissed");
    expect(screen.getByText(/Graded when this game uploaded/)).toBeTruthy();
    expect(screen.getByRole("link", { name: "Open your practice log" }).getAttribute("href")).toBe("/practice");
  });

  it("falls back to grading live against today's target when nothing was stored", () => {
    state.config = { v: 2, slots: { PvT: TODAY } };
    render(<GhostGradeCard gameId="g2" buildLog={LOG} myRace="Protoss" opponentRace="Terran" />);
    expect(screen.getByText("vs Today's opener")).toBeTruthy();
    expect(screen.getByLabelText("Grade S")).toBeTruthy();
  });

  it("makes no request for an account that never used Ghost", () => {
    state.hasConfig = false;
    render(<GhostGradeCard gameId="g3" buildLog={LOG} myRace="Protoss" opponentRace="Terran" />);
    expect(state.paths).toEqual([]);
    expect(screen.queryByTestId("ghost-grade-card")).toBeNull();
  });
});
