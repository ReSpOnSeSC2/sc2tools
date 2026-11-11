import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import Link from "next/link";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import type { Goal, GoalProgress, GoalsResponse } from "@/lib/goals";
import { defaultWindow } from "@/lib/goals";
import { todayKeyIn } from "@/lib/timeseries";

const harness = vi.hoisted(() => ({
  goals: undefined as GoalsResponse | undefined,
  error: null as null | { status: number; message: string },
  mutate: vi.fn(),
  apiCall: vi.fn(),
}));

vi.mock("@clerk/nextjs", () => ({ useAuth: () => ({ getToken: async () => "synthetic", userId: "owner" }) }));
vi.mock("@/components/help/LazyHelpLink", () => ({ LazyHelpLink: ({ children }: { children?: unknown }) => <Link href="/help/goals">{String(children ?? "Help")}</Link> }));
vi.mock("@/lib/timeseries", async (importOriginal) => ({ ...(await importOriginal<typeof import("@/lib/timeseries")>()), clientTimezone: () => "UTC" }));
vi.mock("@/lib/useSeasons", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/useSeasons")>()),
  useSeasons: () => ({ data: { items: [{ battlenetId: 68, region: "US", year: 2026, number: 4, start: "2026-10-01T00:00:00.000Z", end: "2027-01-05T00:00:00.000Z" }], current: 68, source: "pulse", fetchedAt: 0 } }),
}));
vi.mock("@/lib/clientApi", () => ({
  apiCall: (...args: unknown[]) => harness.apiCall(...args),
  useApi: (path: string | null) => {
    if (path?.startsWith("/v1/goals")) return { data: harness.goals, error: harness.error, isLoading: !harness.goals && !harness.error, mutate: harness.mutate };
    if (path?.startsWith("/v1/build-intents/options")) return { data: { matchup: "PvZ", randomizerEnabled: false, usualKey: null, builds: [
      { key: "pvz-2-gate-expand", name: "PvZ - 2 Gate Expand", slug: null, source: "catalog", games: 3, wins: 2, losses: 1, checkins: 0, lastPlayedAt: null, inRandomizer: false, group: "yours" },
    ] }, error: null, isLoading: false, mutate: vi.fn() };
    return { data: undefined, error: null, isLoading: false, mutate: vi.fn() };
  },
}));

import { GoalsTodayCard } from "../GoalsTodayCard";
import { GoalsPage } from "../GoalsPage";
import { NewGoalModal } from "../NewGoalModal";

function progress(overrides: Partial<GoalProgress> = {}): GoalProgress {
  return { state: "active", target: 5, value: 2, fraction: 0.4, games: 2, phase: "progress", met: false, needed: null,
    minGames: null, current: { key: "2026-11-09", startsAt: "2026-11-09T00:00:00.000Z", endsAt: "2026-11-16T00:00:00.000Z" },
    buckets: { total: 4, elapsed: 2, met: 0 }, ...overrides };
}

function goal(id: string, overrides: Partial<Goal> = {}): Goal {
  return { id, type: "games_played", params: { target: 5 }, filters: { matchup: null, map: null, ranked: true },
    window: { recurrence: "weekly", startsOn: "2026-11-02", endsOn: "2026-11-29", tz: "UTC", season: null },
    title: null, label: `Goal ${id}`, pinned: true, status: "active", outcome: null, completedAt: null, createdAt: null,
    progress: progress(), ...overrides };
}

const LIMITS = { maxActive: 8, maxPinned: 3 };

beforeEach(() => {
  harness.goals = undefined; harness.error = null;
  harness.mutate.mockReset(); harness.apiCall.mockReset();
});
afterEach(cleanup);

describe("Today's goals card", () => {
  it("shows up to three pinned goals with their bars and sample guards", () => {
    harness.goals = { limits: LIMITS, completed: [], goals: [
      goal("a"),
      goal("b", { type: "win_rate", params: { target: 55, minGames: 20 }, progress: progress({ phase: "sample", needed: 9, games: 11, value: null, minGames: 20, fraction: 0.55 }) }),
      goal("c", { pinned: false }),
      goal("d"), goal("e"),
    ] };
    render(<GoalsTodayCard />);
    const card = screen.getByTestId("today-goals");
    const bars = within(card).getAllByRole("progressbar");
    expect(bars).toHaveLength(3);
    expect(bars[0].getAttribute("aria-valuenow")).toBe("40");
    expect(within(card).getByText("9 more games before this rate counts")).toBeTruthy();
    expect(within(card).queryByText("Goal c")).toBeNull();
    expect(within(card).getByRole("link", { name: "Manage goals" }).getAttribute("href")).toBe("/app/goals");
  });

  it("invites a first goal, and reports a failed load with Retry", () => {
    harness.goals = { limits: LIMITS, completed: [], goals: [] };
    const view = render(<GoalsTodayCard />);
    expect(screen.getByRole("link", { name: "Set a goal" })).toBeTruthy();
    harness.goals = undefined; harness.error = { status: 500, message: "Something went wrong." };
    view.rerender(<GoalsTodayCard />);
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    expect(harness.mutate).toHaveBeenCalled();
  });
});

describe("Goals page", () => {
  it("pins, deletes after confirming, and replaces the cache with the response", async () => {
    harness.goals = { limits: LIMITS, completed: [goal("old", { status: "completed", outcome: "met", completedAt: "2026-11-01T12:00:00.000Z", pinned: false })],
      goals: [goal("a"), goal("b"), goal("c"), goal("d", { pinned: false })] };
    const next = { ...harness.goals, goals: harness.goals.goals.slice(1) };
    harness.apiCall.mockResolvedValue(next);
    render(<GoalsPage />);
    expect(screen.getByText("Active (4 of 8)")).toBeTruthy();
    expect(screen.getByText("Reached")).toBeTruthy();
    // Three are pinned already: the fourth cannot be pinned.
    expect((screen.getAllByRole("button", { name: "Pin to Today" })[0] as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(screen.getAllByRole("button", { name: "Unpin from Today" })[0]);
    await waitFor(() => expect(harness.apiCall).toHaveBeenCalledWith(expect.any(Function), "/v1/goals/a", { method: "PUT", body: JSON.stringify({ pinned: false }) }));
    fireEvent.click(screen.getByRole("button", { name: "Delete Goal b" }));
    fireEvent.click(await screen.findByRole("button", { name: "Delete" }));
    await waitFor(() => expect(harness.apiCall).toHaveBeenCalledWith(expect.any(Function), "/v1/goals/b", { method: "DELETE" }));
    expect(harness.mutate).toHaveBeenCalledWith(next, { revalidate: false });
  });

  it("disables New goal at the 8-goal limit", () => {
    harness.goals = { limits: LIMITS, completed: [], goals: Array.from({ length: 8 }, (_, i) => goal(`g${i}`)) };
    render(<GoalsPage />);
    expect((screen.getByRole("button", { name: "New goal" }) as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByText(/the most at once/)).toBeTruthy();
  });
});

describe("New goal modal", () => {
  it("creates a win-rate goal with its minimum sample and this month's window", async () => {
    const created = { limits: LIMITS, completed: [], goals: [] };
    harness.apiCall.mockResolvedValue(created);
    const onCreated = vi.fn();
    render(<NewGoalModal open onClose={vi.fn()} onCreated={onCreated} />);
    expect(screen.getByText(/A weekly goal resets every Monday/)).toBeTruthy();
    expect(screen.getByText(/A win rate counts from 20 decided games/)).toBeTruthy();
    fireEvent.click(screen.getByRole("radio", { name: /Win rate/ }));
    expect(screen.getByText("Win 55% of ranked games each month")).toBeTruthy();
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Create goal" })); });
    const [, path, init] = harness.apiCall.mock.calls[0];
    expect(path).toBe("/v1/goals");
    expect(JSON.parse(init.body)).toEqual({
      type: "win_rate",
      params: { target: 55, minGames: 20 },
      filters: { matchup: null, map: null, ranked: true },
      window: { recurrence: "monthly", ...defaultWindow("monthly", todayKeyIn("UTC")), tz: "UTC", season: null },
      title: null,
    });
    expect(onCreated).toHaveBeenCalledWith(created);
  });

  it("adds and clears an optional build filter on an ordinary goal", async () => {
    harness.apiCall.mockResolvedValue({ limits: LIMITS, completed: [], goals: [] });
    render(<NewGoalModal open onClose={vi.fn()} onCreated={vi.fn()} />);
    fireEvent.change(screen.getByLabelText("Matchup"), { target: { value: "PvZ" } });
    const pick = () => fireEvent.click(screen.getByRole("option", { name: /PvZ - 2 Gate Expand/ }));
    pick();
    expect(screen.getByText(/with PvZ - 2 Gate Expand each week/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Clear build filter" }));
    expect(screen.queryByText(/with PvZ - 2 Gate Expand each week/)).toBeNull();
    pick();
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Create goal" })); });
    const body = JSON.parse(harness.apiCall.mock.calls[0][2].body);
    expect(body.type).toBe("games_played");
    expect(body.params.build).toBeUndefined();
    expect(body.filters.build).toMatchObject({ key: "pvz-2-gate-expand", name: "PvZ - 2 Gate Expand" });
  });

  it("needs a matchup and a build for build practice, and uses the picked season's dates", async () => {
    harness.apiCall.mockResolvedValue({ limits: LIMITS, completed: [], goals: [] });
    render(<NewGoalModal open onClose={vi.fn()} onCreated={vi.fn()} />);
    fireEvent.click(screen.getByRole("radio", { name: /Practise a build/ }));
    expect((screen.getByRole("button", { name: "Create goal" }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.change(screen.getByLabelText("Matchup"), { target: { value: "PvZ" } });
    fireEvent.click(screen.getByRole("option", { name: /PvZ - 2 Gate Expand/ }));
    fireEvent.change(screen.getByLabelText("Repeats"), { target: { value: "season" } });
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Create goal" })); });
    const body = JSON.parse(harness.apiCall.mock.calls[0][2].body);
    expect(body).toMatchObject({
      type: "build_reps",
      params: { target: 10, build: { key: "pvz-2-gate-expand", name: "PvZ - 2 Gate Expand", slug: null, source: "catalog" } },
      filters: { matchup: "PvZ", ranked: true },
      window: { recurrence: "season", season: 68, startsOn: "2026-10-01", endsOn: "2027-01-04", tz: "UTC" },
    });
  });
});
