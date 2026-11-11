import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { GhostBuildConfig, GhostTarget } from "@/lib/ghostBuild";
import type { PracticeGamesPage, PracticeSummary } from "@/lib/practiceLog";

const state = vi.hoisted(() => ({
  config: { v: 2, slots: {} } as GhostBuildConfig,
  paths: [] as string[],
  mutate: vi.fn(),
  apiCall: vi.fn(),
  summary: null as unknown,
  games: null as unknown,
}));
vi.mock("@clerk/nextjs", () => ({ useAuth: () => ({ userId: "o", getToken: async () => "token" }) }));
vi.mock("@/lib/useGhostPractice", () => ({
  useGhostPractice: () => ({ owner: "o", config: state.config, hasConfig: true, loading: false, offline: false, saving: false, error: null, readError: null, assign: vi.fn() }),
}));
vi.mock("@/lib/clientApi", () => ({
  apiCall: (...args: unknown[]) => state.apiCall(...args),
  useApi: (path: string | null) => {
    if (path) state.paths.push(path);
    if (path === "/v1/build-intents/randomizer-stats") return { data: { challengeStartedAt: null, pools: [] }, mutate: state.mutate };
    const data = !path ? undefined : path.startsWith("/v1/practice/summary") ? state.summary : state.games;
    return { data, error: undefined, isPreviousData: false, mutate: state.mutate };
  },
}));
vi.mock("@/components/help/LazyHelpLink", () => ({
  LazyHelpLink: ({ slug, anchor, children }: { slug: string; anchor?: string; children: React.ReactNode }) => <a href={`/help/${slug}${anchor ? `#${anchor}` : ""}`}>{children}</a>,
}));

import { PracticeLogPage } from "../PracticeLogPage";

const step = (t: number, name: string) => ({ supply: null, t, name });
const GATE: GhostTarget = { v: 1, name: "PvZ gate core", steps: [step(18, "Pylon"), step(40, "Gateway"), step(90, "CyberneticsCore")] };
const SUMMARY: PracticeSummary = {
  matchup: "PvZ",
  target: { hash: "0123456789abcdef", name: "PvZ gate core", current: true, armedAt: "2026-11-01T10:00:00.000Z", steps: GATE.steps.map((s, i) => ({ i, ...s })) },
  targets: [{ hash: "0123456789abcdef", name: "PvZ gate core", games: 3, lastPlayed: "2026-11-09T00:00:00.000Z", current: true }],
  sample: { graded: 2, ungraded: 1, limit: 200, capped: false },
  grades: { S: 0, A: 1, B: 0, C: 1, D: 0 },
  history: [
    { gameId: "g1", date: "2026-11-09T00:00:00.000Z", grade: "A", avgDrift: 6, matched: 3, total: 3, via: "ingest" },
    { gameId: "g2", date: "2026-11-08T00:00:00.000Z", grade: "C", avgDrift: 22, matched: 2, total: 3, via: "request" },
  ],
  divergence: [{ i: 1, name: "Gateway", games: 1, cut: 0 }],
  steps: [
    { i: 0, name: "Pylon", t: 18, games: 2, hit: 2, avgDrift: 1 },
    { i: 1, name: "Gateway", t: 40, games: 2, hit: 2, avgDrift: 18 },
    { i: 2, name: "CyberneticsCore", t: 90, games: 2, hit: 0, avgDrift: null },
  ],
};
const GAMES: PracticeGamesPage = {
  items: [{
    gameId: "g1", date: "2026-11-09T00:00:00.000Z", map: "Goldenaura", result: "Victory",
    practice: { targetHash: "0123456789abcdef", targetName: "PvZ gate core", status: "graded", grade: "A", matched: 3, total: 3, avgDrift: 6, maxDrift: 12, firstDivergence: null, worstSteps: [], via: "ingest" },
  }],
  nextCursor: null,
};

afterEach(() => {
  cleanup();
  state.paths = [];
  state.mutate.mockReset();
  state.apiCall.mockReset();
  state.config = { v: 2, slots: {} };
});

describe("/practice", () => {
  it("offers a build to practise and the help article when nothing is armed", () => {
    render(<PracticeLogPage />);
    expect(screen.getByRole("heading", { name: "Nothing to practise yet" })).toBeTruthy();
    expect(screen.getByRole("link", { name: "Choose a build to practice" }).getAttribute("href")).toBe("/builds");
    expect(screen.getByRole("link", { name: "How to start" }).getAttribute("href")).toBe("/help/practice-log#start");
    expect(state.paths).toEqual(["/v1/build-intents/randomizer-stats"]);
    expect(screen.getByRole("heading", { name: "Randomizer challenge" })).toBeTruthy();
  });

  it("shows the armed target's progress, per-step timing, fall-off step and graded games", () => {
    state.config = { v: 2, slots: { PvZ: GATE } };
    state.summary = SUMMARY;
    state.games = GAMES;
    render(<PracticeLogPage />);
    expect(state.paths[0]).toBe("/v1/practice/summary?matchup=PvZ");
    expect(screen.getByText("PvZ gate core")).toBeTruthy();
    expect(screen.getByText(/2 graded, 1 without a build log/)).toBeTruthy();
    expect(screen.getByRole("img", { name: "Grades, oldest to newest: C, A" })).toBeTruthy();
    expect(screen.getByRole("progressbar", { name: "Weekly practice goal" })).toBeTruthy();
    expect(screen.getByText(/Average drift over your last 2 graded games/).textContent).toBe("Average drift over your last 2 graded games: 14s");
    expect(screen.getByText("18s late · 2/2 games")).toBeTruthy();
    expect(screen.getByText("never built · 0/2 games")).toBeTruthy();
    expect(screen.getByText(/first slip in 1 of 2 games/)).toBeTruthy();
    expect(screen.getByText("Grade A", { selector: ".sr-only" })).toBeTruthy();
    expect(screen.getByRole("link", { name: "Open game" }).getAttribute("href")).toBe("/app/game/g1#builds");
  });

  it("grades the last games on request and refreshes the summary", async () => {
    state.config = { v: 2, slots: { PvZ: GATE } };
    state.summary = SUMMARY;
    state.games = GAMES;
    state.apiCall.mockResolvedValue({ graded: 7, considered: 7 });
    render(<PracticeLogPage />);
    fireEvent.click(screen.getByRole("button", { name: "Grade my last 20 games" }));
    await waitFor(() => expect(screen.getByRole("status").textContent).toBe("Graded 7 of your recent PvZ games."));
    expect(state.apiCall.mock.calls[0][1]).toBe("/v1/practice/grade-recent");
    expect(state.apiCall.mock.calls[0][2]).toEqual({ method: "POST", body: JSON.stringify({ matchup: "PvZ" }) });
    expect(state.mutate).toHaveBeenCalled();
  });

  it("switches between practised matchups", () => {
    state.config = { v: 2, slots: { PvZ: GATE, PvT: { ...GATE, name: "PvT blink" } } };
    state.summary = SUMMARY;
    state.games = GAMES;
    render(<PracticeLogPage />);
    expect(state.paths[0]).toBe("/v1/practice/summary?matchup=PvT");
    fireEvent.click(screen.getByRole("radio", { name: "PvZ" }));
    expect(state.paths).toContain("/v1/practice/summary?matchup=PvZ");
  });
});
