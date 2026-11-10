import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import OpponentGamesPage from "../../users/[userId]/opponents/[pulseId]/page";
import GlobalPlayerPage from "../../global/players/[pulseId]/page";
import { navigation } from "./navigationFixture";
vi.mock("next/navigation", () => import("./navigationFixture"));

const SUMMARY = { wins: 2, losses: 1, ties: 1, unknown: 0, avgDurationSec: 600, maps: [{ map: "Alcyone", games: 3, wins: 1, losses: 1, ties: 1 }],
  mapOptions: ["Alcyone", "Pylon"], last10: ["win", "tie", "loss", "win"] };
const state = vi.hoisted(() => ({ paths: [] as string[] }));
vi.mock("@/lib/clientApi", () => ({ useApi: (path: string | null) => {
  if (path) state.paths.push(path);
  const common = { error: null, isLoading: false, isValidating: false, mutate: vi.fn() };
  if (path?.includes("/games?")) {
    const params = new URL(path, "https://fixture.invalid").searchParams;
    return { ...common, data: { items: [{ gameId: "g1", userId: "owner-b", userEmail: "b@example.test", result: "Tie", date: "2026-10-28T12:00:00Z",
      myRace: "Protoss", map: "Alcyone", durationSec: 600, opponent: { race: "Zerg", displayName: "Rival" } }], nextBefore: "cursor-2",
      ...(params.has("before") ? {} : { summary: SUMMARY }) } };
  }
  if (path?.includes("/global/players/")) return { ...common, data: { displayNameSample: "Opponent", race: "Z", gameCount: 5, wins: 3, losses: 1, winRate: .75,
    trackedByUsers: 2, mmr: null, lastSeen: null, strategies: [], maps: [{ key: "Alcyone", count: 3, wins: 1, winRate: .3 }, { key: "Pylon", count: 2, wins: 2, winRate: 1 }],
    perUser: [{ userId: "owner-a", email: "a@example.test", gameCount: 3, wins: 2, losses: 1, winRate: .66, mmr: null, lastSeen: null },
      { userId: "owner-b", email: null, gameCount: 2, wins: 1, losses: 0, winRate: 1, mmr: null, lastSeen: null }] } };
  return { ...common, data: undefined };
} }));
vi.mock("../AdminGameDetail", () => ({ AdminGameDetail: () => null, fmtDate: () => "date", fmtDuration: () => "10:00" }));
vi.mock("@/components/analyzer/OpponentDiagnosticsPanel", () => ({ OpponentDiagnosticsPanel: () => null }));
beforeEach(() => { state.paths = []; });
afterEach(cleanup);
const url = () => new URL(navigation.url, "https://fixture.invalid");
const lastGamesPath = () => state.paths.filter((path) => path.includes("/games?")).at(-1) || "";

it("opponent result chips and map select live in the URL, reset the cursor and keep the summary", async () => {
  navigation.url = "/admin/users/owner/opponents/pulse?before=cursor-1&game=g1";
  await act(async () => { render(<OpponentGamesPage params={Promise.resolve({ userId: "owner", pulseId: "pulse" })} />); });
  // An older page asks for the unfiltered summary with a one-game first page.
  expect(state.paths).toContain("/v1/admin/users/owner/opponents/pulse/games?limit=1");
  expect(screen.getByRole("heading", { name: "Head-to-head" })).toBeTruthy();
  const chips = screen.getByRole("group", { name: "Filter by result" });
  expect(within(chips).getByRole("button", { name: "All" }).getAttribute("aria-pressed")).toBe("true");
  fireEvent.click(within(chips).getByRole("button", { name: "Ties" }));
  expect(url().searchParams.get("result")).toBe("tie");
  expect(url().searchParams.has("before")).toBe(false);
  expect(url().searchParams.get("game")).toBe("g1");
  expect(lastGamesPath()).toBe("/v1/admin/users/owner/opponents/pulse/games?limit=50&result=tie");
  expect(within(chips).getByRole("button", { name: "Ties" }).getAttribute("aria-pressed")).toBe("true");
  const map = screen.getByRole("combobox", { name: "Map" });
  expect([...(map as HTMLSelectElement).options].map((option) => option.value)).toEqual(["", "Alcyone", "Pylon"]);
  fireEvent.change(map, { target: { value: "Pylon" } });
  expect(url().searchParams.get("map")).toBe("Pylon");
  expect(lastGamesPath()).toBe("/v1/admin/users/owner/opponents/pulse/games?limit=50&result=tie&map=Pylon");
  fireEvent.click(screen.getByRole("button", { name: "Clear filters" }));
  expect(url().searchParams.has("result")).toBe(false);
  expect(url().searchParams.has("map")).toBe(false);
});

it("an unknown result value in a shared link falls back to All", async () => {
  navigation.url = "/admin/users/owner/opponents/pulse?result=undecided";
  await act(async () => { render(<OpponentGamesPage params={Promise.resolve({ userId: "owner", pulseId: "pulse" })} />); });
  expect(lastGamesPath()).toBe("/v1/admin/users/owner/opponents/pulse/games?limit=50");
});

it("global player games add a User select and send result, map and userId filters", async () => {
  navigation.url = "/admin/global/players/pulse?before=cursor-1";
  await act(async () => { render(<GlobalPlayerPage params={Promise.resolve({ pulseId: "pulse" })} />); });
  const user = screen.getByRole("combobox", { name: "User" });
  expect([...(user as HTMLSelectElement).options].map((option) => option.textContent)).toEqual(["All users", "a@example.test", "owner-b"]);
  fireEvent.change(user, { target: { value: "owner-b" } });
  expect(url().searchParams.get("userId")).toBe("owner-b");
  expect(url().searchParams.has("before")).toBe(false);
  fireEvent.click(screen.getByRole("button", { name: "Wins" }));
  fireEvent.change(screen.getByRole("combobox", { name: "Map" }), { target: { value: "Alcyone" } });
  expect(lastGamesPath()).toBe("/v1/admin/global/players/pulse/games?limit=50&result=win&map=Alcyone&userId=owner-b");
});
