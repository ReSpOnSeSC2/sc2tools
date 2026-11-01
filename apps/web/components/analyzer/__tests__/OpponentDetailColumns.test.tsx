import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { OpponentDetailCells, opponentGameLength } from "../opponents/OpponentDetailColumns";
import { opponentColumns } from "@/lib/opponentPresentation";
import type { Opp } from "../opponents/types";
import type { ComponentProps, ReactNode } from "react";
import { groupOpponentsByPlayer } from "@/lib/opponentGroups";
import { OPPONENT_QUERY_PARAM } from "@/lib/opponentNavigation";

const calls = vi.hoisted(() => ({ download: vi.fn() }));
vi.mock("@clerk/nextjs", () => ({ useAuth: () => ({ isLoaded: true, isSignedIn: true, userId: "synthetic-owner", getToken: async () => "synthetic-token" }) }));
vi.mock("next/link", () => ({ default: ({ children, prefetch: _prefetch, ...props }: ComponentProps<"a"> & { children?: ReactNode; prefetch?: boolean }) => <a {...props}>{children}</a> }));
vi.mock("@/lib/filterContext", async original => ({ ...await original<typeof import("@/lib/filterContext")>(), useFilters: () => ({ filters: {} }) }));
vi.mock("@/lib/clientApi", async original => ({ ...await original<typeof import("@/lib/clientApi")>(), apiCall: (...args: unknown[]) => calls.download(...args) }));

const row: Opp = { pulseId: "synthetic-opponent", name: "Synthetic rival", wins: 1, losses: 0, games: 1, winRate: 1, lastPlayed: "2026-10-23T12:00:00Z",
  latestGame: { gameId: "latest-game", date: "2026-10-23T12:00:00Z", durationSec: 630, map: "Synthetic arena", result: "Victory", myBuild: "My actual build", oppStrategy: "Opponent actual build", macroScore: 0, top3Leaks: ["Supply blocked"], replayAvailable: true, replaySizeBytes: 4096 },
  duration: { sumSec: 1500, samples: 2, averageSec: 750 }, macro: { sum: 0, samples: 1, average: 0 },
  latestOppBuildOrder: { gameId: "older-order-game", date: "2026-10-20T12:00:00Z" }, opponentBuildOrderAvailability: "unknown" };
beforeEach(() => { history.replaceState(null, "", "/app/opponents?q=Synthetic"); calls.download.mockReset(); });
afterEach(() => { cleanup(); vi.restoreAllMocks(); });
const columns = opponentColumns({ latestReplay: true, macroBreakdown: true, lastGameLength: true, avgGameLength: true, avgMacroScore: true, myBuild: true, opponentBuild: true, opponentBuildOrder: true, map: true, buildOrderDate: true }, false);

it("shows scoped game values and independently dated orders without fetching on render", () => {
  render(<table><tbody><tr><OpponentDetailCells row={row} columns={columns} /></tr></tbody></table>);
  expect(screen.getByText("10:30")).toBeTruthy(); expect(screen.getByText("12:30")).toBeTruthy();
  expect(screen.getByText("My actual build")).toBeTruthy(); expect(screen.getByText("Opponent actual build")).toBeTruthy();
  expect(screen.getByText("Synthetic arena")).toBeTruthy(); expect(screen.getByText("Latest known")).toBeTruthy();
  const macro = screen.getByRole("link", { name: "Open your macro breakdown for the latest game vs Synthetic rival" });
  expect(macro.textContent).toBe("0/100 · Details"); expect(macro.getAttribute("href")).toMatch(/^\/app\/game\/latest-game\?.*#macro$/);
  expect(screen.getByRole("link", { name: "Inspect the last known opponent build order for Synthetic rival" }).getAttribute("href")).toMatch(/^\/app\/game\/older-order-game\?.*#builds$/);
  expect(screen.queryByText("View recorded order")).toBeNull();
  expect(calls.download).not.toHaveBeenCalled();
});
it("labels an applied opponent correction Corrected and your own check-in Planned", () => {
  const latestGame = { ...row.latestGame!, buildPlanned: true, oppStrategyPlanned: true };
  render(<table><tbody><tr><OpponentDetailCells row={{ ...row, latestGame }} columns={columns} /></tr></tbody></table>);
  expect(screen.getByText("My actual build").parentElement?.textContent).toBe("My actual buildPlanned");
  expect(screen.getByText("Opponent actual build").parentElement?.textContent).toBe("Opponent actual buildCorrected");
});
it("downloads only on explicit click and does not open the dossier row", async () => {
  calls.download.mockResolvedValue({ url: "https://synthetic.invalid/replay", filename: "synthetic.SC2Replay" });
  const rowOpen = vi.fn(), click = vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => {});
  render(<table><tbody><tr onClick={rowOpen}><OpponentDetailCells row={row} columns={opponentColumns({ latestReplay: true }, false)} /></tr></tbody></table>);
  fireEvent.click(screen.getByRole("button", { name: "Download replay — latest game vs Synthetic rival" }));
  await waitFor(() => expect(click).toHaveBeenCalledTimes(1));
  expect(calls.download.mock.calls[0][1]).toBe("/v1/games/latest-game/replay-download");
  expect(rowOpen).not.toHaveBeenCalled();
});
it("keeps legacy order dates unknown and offers inspection rather than a fabricated date", () => {
  const legacy = { ...row, latestOppBuildOrder: null };
  render(<OpponentDetailCells row={legacy} columns={columns} mobile />);
  expect(screen.getByText("Not indexed")).toBeTruthy();
  expect(screen.getByRole("link", { name: "Inspect opponent build orders in the latest game vs Synthetic rival" }).getAttribute("href")).toMatch(/latest-game.*#builds$/);
  expect(screen.getByText("Average game length").tagName).toBe("DT");
  expect(screen.queryByText("No recorded order")).toBeNull();
});
it("distinguishes measured zero time from an unknown duration", () => {
  expect(opponentGameLength(0)).toBe("0:00"); expect(opponentGameLength(null)).toBe("—");
  expect(opponentGameLength(Number.NaN)).toBe("—"); expect(opponentGameLength(-1)).toBe("—");
});
it("keeps the carrier account for grouped game and build-order navigation", () => {
  const older: Opp = { ...row, pulseId: "older-account", pulseCharacterId: "1", name: "Older account" };
  const primary: Opp = { ...row, pulseId: "primary-account", pulseCharacterId: "2", name: "Primary account",
    lastPlayed: "2026-10-25T12:00:00Z", latestGame: { ...row.latestGame!, gameId: "other-game", date: "2026-10-20T12:00:00Z" }, latestOppBuildOrder: null };
  const [group] = groupOpponentsByPlayer([older, primary], { 1: { accountId: "same", proId: null, proNickname: null }, 2: { accountId: "same", proId: null, proNickname: null } });
  expect(group.pulseId).toBe("primary-account");
  render(<OpponentDetailCells row={group} columns={opponentColumns({ macroBreakdown: true, opponentBuildOrder: true }, false)} mobile />);
  for (const label of ["Open your macro breakdown for the latest game vs Primary account", "Inspect the last known opponent build order for Primary account"]) {
    const href = screen.getByRole("link", { name: label }).getAttribute("href")!;
    expect(new URL(href, "https://example.test").searchParams.get(OPPONENT_QUERY_PARAM)).toBe("older-account");
  }
});
