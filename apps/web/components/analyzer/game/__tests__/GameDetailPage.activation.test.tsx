import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import { type ReactNode } from "react";
import { SWRConfig } from "swr";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { GameSummary } from "../types";
import { FIRST_GAME_VIEWED_PATH } from "@/lib/activation";
import { GameDetailPage } from "../GameDetailPage";

const state = vi.hoisted(() => ({ owner: "owner-a" as string | null, getToken: vi.fn(), useApi: vi.fn() }));
vi.mock("@clerk/nextjs", () => ({ useAuth: () => ({ userId: state.owner, isLoaded: true, isSignedIn: !!state.owner, getToken: state.getToken }) }));
vi.mock("next/navigation", () => ({ useRouter: () => ({ replace: vi.fn(), push: vi.fn() }) }));
vi.mock("@/lib/clientApi", async original => ({ ...await original<typeof import("@/lib/clientApi")>(), useApi: state.useApi }));
// The actual page decides admission. Unrelated replay children are not mounted.
vi.mock("../GameDetailShell", () => ({ GameDetailShell: ({ game }: { game: GameSummary }) => <h1>Private game {game.gameId}</h1> }));
let current: { data?: GameSummary; error?: { status: number }; isLoading: boolean; isPreviousData: boolean };
let requests: { path: string; method: string; body: unknown }[];
const game = (gameId = "game-1"): GameSummary => ({ gameId, date: "2026-10-26T12:00:00.000Z", myRace: "Protoss", result: "Victory", map: "Synthetic map", durationSec: 420, opponent: { displayName: "Synthetic opponent", race: "Zerg" } });
const empty = () => ({ data: undefined, error: undefined, isLoading: true, isPreviousData: false, mutate: vi.fn(), request: vi.fn() });
function Wrapper({ children }: { children: ReactNode }) { return <SWRConfig value={{ provider: () => new Map() }}>{children}</SWRConfig>; }
beforeEach(() => {
  state.owner = "owner-a"; state.getToken.mockReset().mockResolvedValue("synthetic-owner-token"); requests = [];
  current = { data: undefined, isLoading: true, isPreviousData: false };
  state.useApi.mockReset().mockImplementation((path: string | null) => /^\/v1\/games\/game-[12]$/.test(path ?? "") ? { ...empty(), ...current } : empty());
  vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init: RequestInit = {}) => {
    requests.push({ path: new URL(String(input)).pathname, method: init.method ?? "GET", body: JSON.parse(String(init.body ?? "null")) });
    return new Response(JSON.stringify({ firstGameViewed: true }), { headers: { "content-type": "application/json" } });
  }));
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

describe("GameDetailPage first-view integration", () => {
  it("waits for the actual successful matching game body, not route mount or loading", async () => {
    const view = render(<GameDetailPage gameId="game-1" />, { wrapper: Wrapper });
    await act(async () => {}); expect(requests).toEqual([]);
    current = { data: game(), isLoading: false, isPreviousData: false }; view.rerender(<GameDetailPage gameId="game-1" />);
    await screen.findByRole("heading", { name: "Private game game-1" });
    await waitFor(() => expect(requests).toEqual([{ path: FIRST_GAME_VIEWED_PATH, method: "PUT", body: { gameId: "game-1" } }]));
    expect(state.useApi.mock.calls.map(call => call[0])).not.toContain("/v1/me/activation");
  });
  it("does not mark a private 404 or a failed response", async () => {
    current = { data: undefined, error: { status: 404 }, isLoading: false, isPreviousData: false };
    const view = render(<GameDetailPage gameId="game-1" />, { wrapper: Wrapper });
    await screen.findByText("Game not found"); await act(async () => {}); expect(requests).toEqual([]);
    current = { data: undefined, error: { status: 503 }, isLoading: false, isPreviousData: false }; view.rerender(<GameDetailPage gameId="game-1" />);
    await screen.findByText("Couldn't load this game"); expect(requests).toEqual([]);
  });
  it("does not mark a retained or mismatched body after route navigation", async () => {
    current = { data: game(), isLoading: false, isPreviousData: true };
    const view = render(<GameDetailPage gameId="game-1" />, { wrapper: Wrapper });
    await act(async () => {}); expect(requests).toEqual([]);
    current = { data: game(), isLoading: false, isPreviousData: false }; view.rerender(<GameDetailPage gameId="game-2" />);
    await act(async () => {}); expect(requests).toEqual([]);
    current = { data: game("game-2"), isLoading: false, isPreviousData: false }; view.rerender(<GameDetailPage gameId="game-2" />);
    await waitFor(() => expect(requests).toHaveLength(1)); expect(requests[0].body).toEqual({ gameId: "game-2" });
  });
  it("does not mark a loaded game while signed out", async () => {
    state.owner = null; current = { data: game(), isLoading: false, isPreviousData: false };
    render(<GameDetailPage gameId="game-1" />, { wrapper: Wrapper }); await act(async () => {});
    expect(requests).toEqual([]); expect(state.getToken).not.toHaveBeenCalled();
  });
});
