import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import OpponentGamesPage from "../../users/[userId]/opponents/[pulseId]/page";
import GlobalPlayerPage from "../../global/players/[pulseId]/page";
import { navigation } from "./navigationFixture";
vi.mock("next/navigation", () => import("./navigationFixture"));
const state = vi.hoisted(() => ({ missing: false, paths: [] as (string | null)[] }));
vi.mock("@/lib/clientApi", () => ({ useApi: (path: string | null) => {
  state.paths.push(path);
  const common = { error: null, isLoading: false, isValidating: false, mutate: vi.fn() };
  if (path?.endsWith("/build-order")) return { ...common, data: state.missing ? undefined : { my_race: "P", opp_race: "Z" }, error: state.missing ? { status: 404, code: "game_not_found", message: "Game not found" } : null };
  if (path?.includes("/games?")) return { ...common, data: { items: [], nextBefore: null } };
  if (path?.includes("/global/players/")) return { ...common, data: { displayNameSample: "Opponent", race: "Z", gameCount: 5, wins: 3, losses: 2, winRate: .6, trackedByUsers: 1, mmr: null, lastSeen: null, perUser: [], strategies: [], maps: [] } };
  return { ...common, data: undefined };
} }));
// The chart renderer has its own tests; this boundary exposes the actual selected owner/game contract.
vi.mock("../AdminGameDetail", () => ({ AdminGameDetail: ({ userId, game }: { userId: string; game: { gameId: string } }) => <section aria-label="Selected detail">{userId}:{game.gameId}</section>, fmtDate: () => "date", fmtDuration: () => "duration", isWin: () => false }));
vi.mock("@/components/analyzer/OpponentDiagnosticsPanel", () => ({ OpponentDiagnosticsPanel: () => null }));
beforeEach(() => { state.missing = false; state.paths = []; });
afterEach(cleanup);
it("opens an off-page opponent game from the URL through its owner-scoped endpoint", async () => {
  navigation.url = "/admin/users/owner/opponents/pulse?game=off-page&before=shared";
  await act(async () => { render(<OpponentGamesPage params={Promise.resolve({ userId: "owner", pulseId: "pulse" })} />); });
  expect(screen.getByRole("region", { name: "Selected detail" }).textContent).toBe("owner:off-page");
  expect(screen.getByText(/isn.t on the current page/)).toBeTruthy(); expect(state.paths).toContain("/v1/admin/users/owner/games/off-page/build-order");
  expect(screen.getByRole("button", { name: "First page" })).toBeTruthy();
});
it("requires and preserves the selected game's owner on a global player deep link", async () => {
  navigation.url = "/admin/global/players/pulse?game=off-page&owner=other-owner";
  await act(async () => { render(<GlobalPlayerPage params={Promise.resolve({ pulseId: "pulse" })} />); });
  expect(screen.getByRole("region", { name: "Selected detail" }).textContent).toBe("other-owner:off-page"); expect(state.paths).toContain("/v1/admin/users/other-owner/games/off-page/build-order");
});
it("an unknown selected game shows Game not found and clears only that selection", async () => {
  state.missing = true; navigation.url = "/admin/users/owner/opponents/pulse?game=unknown&debug=1";
  await act(async () => { render(<OpponentGamesPage params={Promise.resolve({ userId: "owner", pulseId: "pulse" })} />); });
  expect(screen.getByRole("heading", { name: "Game not found" })).toBeTruthy(); fireEvent.click(screen.getByRole("button", { name: "Clear selection" }));
  expect(navigation.url).toBe("/admin/users/owner/opponents/pulse?debug=1"); expect(screen.queryByRole("region", { name: "Selected detail" })).toBeNull();
});
