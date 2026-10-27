import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { ArcadeDataset } from "../types";
import type { SessionPolicy } from "@/lib/session-policy";

const mocks = vi.hoisted(() => ({
  data: null as ArcadeDataset | null, baseData: null as ArcadeDataset | null,
  owner: "", day: "2026-10-27", rng: () => 0.5,
  recordPlay: vi.fn(), earnBadge: vi.fn(), retry: vi.fn(),
}));
vi.mock("../hooks/useArcadeData", () => ({ useArcadeData: () => ({
  data: mocks.data, baseData: mocks.baseData, loading: false, error: null,
  retrySessionPolicy: mocks.retry,
}) }));
vi.mock("../hooks/useDailySeed", () => ({ useDailySeed: () => ({
  userId: mocks.owner, day: mocks.day, tz: "UTC", rng: mocks.rng,
}) }));
vi.mock("../hooks/useArcadeState", () => ({ useArcadeState: () => ({
  recordPlay: mocks.recordPlay, earnBadge: mocks.earnBadge,
  state: { buildleByDay: {}, streak: { count: 0, lastPlayedDay: null },
    xp: { total: 0 }, level: 1, minerals: 0, cosmetics: { mascotSkin: "default" } },
}) }));
// Keep the actual two session generators and their real renderer. The small
// independent quiz makes an answered-round retention failure deterministic.
vi.mock("../modes", async () => {
  const { createElement } = await import("react");
  const { firstGameOfDay } = await import("../modes/quizzes/firstGameOfDay");
  const { comebackCount } = await import("../modes/quizzes/comebackCount");
  const independent: import("../modes").AnyMode = {
    id: "synthetic-independent", kind: "quiz", category: "macro", difficulty: "easy", ttp: "fast", depthTag: "conditional",
    title: "Independent quiz", blurb: "A bounded synthetic independent round",
    generate: async () => ({ ok: true, minDataMet: true, question: "Recorded independent round" }),
    score: () => ({ raw: 1, xp: 10, outcome: "correct", note: "Recorded" }),
    render: ctx => createElement("section", null,
      createElement("h3", null, String(ctx.question)),
      createElement("output", { "aria-label": "Independent answer" }, ctx.revealed ? "answered" : "unanswered"),
      createElement("button", { type: "button", onClick: () => ctx.onAnswer("yes") }, "Answer independent round")),
  };
  return { QUIZZES: [firstGameOfDay, comebackCount, independent], GAMES: [] };
});
vi.mock("../DailyQuests", () => ({ DailyQuests: () => null }));
vi.mock("../hud/StreakHUD", () => ({ StreakHUD: () => null }));
vi.mock("../hud/XpBar", () => ({ XpBar: () => null }));
vi.mock("../hud/MascotCorner", () => ({ MascotCorner: () => null }));
vi.mock("../ShareCard", () => ({ shareCard: vi.fn() }));
vi.mock("../surfaces/DailyEmptyState", () => ({ DailyEmptyState: ({ kind }: { kind: string }) => <p>Daily {kind} unavailable</p> }));

import { TodaySurface } from "../surfaces/Today";
import { useEligibleDailyPicks } from "../hooks/useEligibleDailyPicks";
import { dailySeed, mulberry32 } from "../ArcadeEngine";
import { firstGameOfDay } from "../modes/quizzes/firstGameOfDay";

const player: SessionPolicy = { gapMinutes: 90, source: "auto-player", storedGapMinutes: null };
const overlay: SessionPolicy = { gapMinutes: 240, source: "auto-overlay", storedGapMinutes: null };
const preference = (gapMinutes: number): SessionPolicy => ({ gapMinutes, source: "preference", storedGapMinutes: gapMinutes });
function chooseOwner(day: string, prefix = "daily-owner-") {
  for (let index = 0; index < 256; index++) {
    const owner = `${prefix}${index}`;
    if (Math.floor(mulberry32(dailySeed(owner, day))() * 3) === 0) return owner;
  }
  throw new Error("Expected a deterministic first-session-mode seed");
}
function setPolicy(policy: SessionPolicy | null, error: string | null = null) {
  mocks.data = { ...mocks.baseData!, sessionPolicy: policy, sessionPolicyError: error };
}
function Eligibility() {
  const picks = useEligibleDailyPicks(mocks.data);
  return <output aria-label="Daily eligibility">{picks.probing ? "probing" : picks.eligibleQuizIds.join(",")}</output>;
}
function View() { return <><TodaySurface /><Eligibility /></>; }
async function expectSessionEligibility(available: boolean) {
  await waitFor(() => {
    const text = screen.getByRole("status", { name: "Daily eligibility" }).textContent ?? "";
    expect(text).not.toBe("probing");
    for (const id of ["first-game-of-day", "comeback-count"]) {
      if (available) expect(text.split(",")).toContain(id);
      else expect(text.split(",")).not.toContain(id);
    }
  });
}

beforeEach(() => {
  mocks.day = "2026-10-27"; mocks.owner = chooseOwner(mocks.day);
  mocks.recordPlay.mockReset(); mocks.earnBadge.mockReset(); mocks.retry.mockReset().mockResolvedValue(undefined);
  const start = Date.parse("2026-10-20T00:00:00Z");
  const games = Array.from({ length: 5 }, (_, session) => Array.from({ length: 4 }, (_, position) => ({
    gameId: `${session}-${position}`, date: new Date(start + session * 5 * 3_600_000 + position * 60_000).toISOString(),
    result: "Victory", myRace: "P", oppRace: "Z",
  }))).flat();
  mocks.baseData = { games, opponents: [], builds: [], customBuilds: [], communityBuilds: [], matchups: [], maps: [], summary: null, mapPool: [] };
  setPolicy(null, "Loading session settings");
});
afterEach(() => { cleanup(); vi.restoreAllMocks(); });

it("the actual Today consumer re-probes fixed-size corpus on policy arrival, failure/retry and effective identity changes", async () => {
  const generate = vi.spyOn(firstGameOfDay, "generate");
  const view = render(<View />);
  await expectSessionEligibility(false);
  const games = mocks.baseData!.games;
  setPolicy(player); view.rerender(<View />); await expectSessionEligibility(true);
  const afterPlayer = generate.mock.calls.length;
  // Same gap, new validated source/stored identity still re-probes.
  setPolicy(preference(90)); view.rerender(<View />);
  await waitFor(() => expect(generate.mock.calls.length).toBeGreaterThan(afterPlayer));
  await expectSessionEligibility(true);
  const afterPreference = generate.mock.calls.length;
  setPolicy(preference(90)); view.rerender(<View />);
  await act(async () => { await Promise.resolve(); });
  expect(generate.mock.calls.length).toBe(afterPreference);
  setPolicy(null, "Synthetic failed refresh"); view.rerender(<View />); await expectSessionEligibility(false);
  setPolicy(overlay); view.rerender(<View />); await expectSessionEligibility(true);
  setPolicy(preference(480)); view.rerender(<View />); await expectSessionEligibility(false);
  expect(mocks.baseData!.games).toBe(games); expect(mocks.data!.games).toBe(games);
});

it("the actual Today runner retains an answered independent round when policy arrives and retries", async () => {
  const view = render(<View />);
  await screen.findByRole("heading", { name: "Recorded independent round" });
  fireEvent.click(screen.getByRole("button", { name: "Answer independent round" }));
  expect(screen.getByRole("status", { name: "Independent answer" }).textContent).toBe("answered");
  expect(mocks.recordPlay).toHaveBeenCalledOnce();
  for (const policy of [preference(45), null, overlay, preference(480), player]) {
    setPolicy(policy, policy ? null : "Synthetic failed refresh"); view.rerender(<View />);
    await expectSessionEligibility(policy !== null && policy.gapMinutes !== 480);
    expect(screen.getByRole("heading", { name: "Recorded independent round" })).toBeTruthy();
    expect(screen.getByRole("status", { name: "Independent answer" }).textContent).toBe("answered");
    expect(mocks.recordPlay).toHaveBeenCalledOnce();
  }
});

it("an initially admitted session quiz renders its actual configured gap in Today", async () => {
  // Depends on the separately owned Kernel overlay's q -> ctx.question fix.
  setPolicy(preference(45)); render(<View />);
  await expectSessionEligibility(true);
  await screen.findByRole("heading", { name: "First-Game-of-Day" });
  expect(screen.getByText(/A "session" ends after more than 45 minutes without a game/)).toBeTruthy();
  expect(mocks.recordPlay).not.toHaveBeenCalled();
});

it("a new owner/day cannot retain the previous owner's answered independent pick", async () => {
  const view = render(<View />);
  await screen.findByRole("heading", { name: "Recorded independent round" });
  fireEvent.click(screen.getByRole("button", { name: "Answer independent round" }));
  mocks.day = "2026-10-28"; mocks.owner = chooseOwner(mocks.day, "next-owner-"); setPolicy(preference(45));
  view.rerender(<View />);
  expect(screen.queryByRole("status", { name: "Independent answer" })).toBeNull();
  await expectSessionEligibility(true);
  await screen.findByRole("heading", { name: "First-Game-of-Day" });
  expect(screen.queryByRole("status", { name: "Independent answer" })).toBeNull();
  expect(mocks.recordPlay).toHaveBeenCalledOnce();
});