import type { ReactNode } from "react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { LeaderboardTab } from "../LeaderboardTab";

const mocks = vi.hoisted(() => ({ loaded: true, signedIn: true, search: "", replace: vi.fn(), useApi: vi.fn(), mutate: vi.fn() }));
vi.mock("next/navigation", () => ({ useSearchParams: () => new URLSearchParams(mocks.search), useRouter: () => ({ replace: mocks.replace }) }));
vi.mock("@clerk/nextjs", () => ({ useAuth: () => ({ isLoaded: mocks.loaded }), SignedIn: ({ children }: { children: ReactNode }) => mocks.signedIn ? children : null, SignedOut: ({ children }: { children: ReactNode }) => mocks.signedIn ? null : children }));
vi.mock("@/lib/clientApi", () => ({ useApi: (...args: unknown[]) => mocks.useApi(...args) }));
vi.mock("@/components/help/LazyHelpLink", () => ({ LazyHelpLink: ({ children }: { children: ReactNode }) => <span>{children}</span> }));
const data = { weekKey: "2026-W42", items: [{ rank: 14, displayName: "Reader", pnlPct: 4.2, isAnonymous: false, settled: true, isYou: true }], participants: 63, settledCount: 50, you: { rank: 14, pnlPct: 4.2, settled: true } };
beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] }); vi.setSystemTime(new Date("2026-10-23T12:00:00Z"));
  mocks.loaded = true; mocks.signedIn = true; mocks.search = ""; mocks.replace.mockReset(); mocks.mutate.mockReset(); mocks.useApi.mockReset();
  mocks.useApi.mockReturnValue({ data, isLoading: false, mutate: mocks.mutate });
});
afterEach(() => { cleanup(); vi.useRealTimers(); });

it("waits for Clerk before offering the member-only board", () => {
  mocks.loaded = false; render(<LeaderboardTab />);
  expect(screen.getByRole("status", { name: "Loading leaderboard" })).toBeTruthy();
  expect(screen.queryByRole("link", { name: "Sign in" })).toBeNull(); expect(mocks.useApi).not.toHaveBeenCalled();
});
it("explains privacy signed out and preserves a validated week for sign-in", () => {
  mocks.signedIn = false; mocks.search = "week=2026-W41"; render(<LeaderboardTab />);
  expect(screen.getByText("Sign in to see this week's leaderboard")).toBeTruthy();
  expect(screen.getByRole("link", { name: "Sign in" }).getAttribute("href")).toBe("/sign-in?redirect_url=%2Fcommunity%2Fleaderboard%3Fweek%3D2026-W41");
  expect(mocks.useApi).not.toHaveBeenCalled();
});
it("defaults to the settled week, pins your rank and navigates through URL weeks", () => {
  render(<LeaderboardTab />);
  expect(mocks.useApi).toHaveBeenCalledWith("/v1/arcade/leaderboard?weekKey=2026-W42&limit=50");
  expect(screen.getByText("Your rank: #14 of 63 · +4.2%")).toBeTruthy();
  expect(screen.getByRole("table").querySelector("caption")?.textContent).toBe("Stock Market weekly P&L, Oct 12 – 18, 2026");
  fireEvent.click(screen.getByRole("button", { name: "‹ Prev week" }));
  expect(mocks.replace).toHaveBeenCalledWith("/community/leaderboard?week=2026-W41", { scroll: false });
  fireEvent.click(screen.getByRole("button", { name: "Next week ›" }));
  expect(mocks.replace).toHaveBeenLastCalledWith("/community/leaderboard?week=2026-W43", { scroll: false });
  fireEvent.click(screen.getByRole("button", { name: "Show more" }));
  expect(mocks.useApi).toHaveBeenLastCalledWith("/v1/arcade/leaderboard?weekKey=2026-W42&limit=200");
});
it("shows current-week locks and cannot navigate into the future", () => {
  mocks.search = "week=2026-W43"; render(<LeaderboardTab />);
  expect(screen.getByText("Locked")).toBeTruthy();
  expect((screen.getByRole("button", { name: "Next week ›" }) as HTMLButtonElement).disabled).toBe(true);
  expect(screen.getByText("You're on this week's board — locked")).toBeTruthy();
  expect(screen.queryByRole("button", { name: "This week" })).toBeNull();
});
it.each(["week=2026-W99", "week=2027-W01"])("falls back safely for invalid or future weeks: %s", (search) => {
  mocks.search = search; render(<LeaderboardTab />);
  expect(mocks.useApi).toHaveBeenCalledWith("/v1/arcade/leaderboard?weekKey=2026-W42&limit=50");
});
it("offers Retry on a failed board request", () => {
  mocks.useApi.mockReturnValue({ error: { status: 500 }, isLoading: false, mutate: mocks.mutate }); render(<LeaderboardTab />);
  expect(screen.getByText("Couldn't load the leaderboard")).toBeTruthy(); fireEvent.click(screen.getByRole("button", { name: "Retry" }));
  expect(mocks.mutate).toHaveBeenCalledTimes(1);
});
