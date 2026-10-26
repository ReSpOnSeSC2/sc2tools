import { useEffect } from "react";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
const fixture = vi.hoisted(() => ({ load: vi.fn(), subscribe: vi.fn(), unsubscribe: vi.fn() }));
vi.mock("./scoutingBriefLoader", () => ({ loadScoutingBriefCard: () => fixture.load() }));
vi.mock("@clerk/nextjs", () => ({ useAuth: () => ({ userId: "synthetic-owner", isLoaded: true, isSignedIn: true, getToken: async () => "synthetic" }) }));
vi.mock("@/lib/useLiveGame", () => ({ useLiveGame: () => {
  useEffect(() => { fixture.subscribe(); return fixture.unsubscribe; }, []);
  return { live: { type: "liveGameState", phase: "match_started", gameKey: "synthetic", capturedAt: 1, receivedAt: Date.now(), opponent: { name: "Synthetic opponent", race: "Zerg" }, streamerHistory: { oppName: "Synthetic opponent", opponentIdentityMatched: true, headToHead: { wins: 2, losses: 1 } } }, lastUpdatedAt: Date.now(), retry: vi.fn() };
} }));
import { LiveScoutingBrief } from "./LiveScoutingBrief";
beforeEach(() => { fixture.load.mockReset(); fixture.subscribe.mockClear(); fixture.unsubscribe.mockClear(); });
afterEach(() => { cleanup(); vi.restoreAllMocks(); });

it("recovers a failed optional chunk through a fresh attempt without remounting the SSE subscription", async () => {
  vi.spyOn(console, "error").mockImplementation(() => {});
  fixture.load.mockRejectedValueOnce(new Error("Synthetic chunk load failure"));
  fixture.load.mockImplementationOnce(async () => ({ default: (await vi.importActual<typeof import("./ScoutingBriefCard")>("./ScoutingBriefCard")).ScoutingBriefCard }));
  render(<><h1>Today stays available</h1><LiveScoutingBrief /></>);
  const retry = await screen.findByRole("button", { name: "Retry live brief" });
  expect(screen.getByRole("heading", { name: "Today stays available" })).toBeTruthy();
  expect(fixture.load).toHaveBeenCalledTimes(1); expect(fixture.subscribe).toHaveBeenCalledTimes(1); expect(fixture.unsubscribe).not.toHaveBeenCalled();
  fireEvent.click(retry);
  expect(await screen.findByText("Your record: 2W 1L")).toBeTruthy();
  expect(fixture.load).toHaveBeenCalledTimes(2); expect(fixture.subscribe).toHaveBeenCalledTimes(1); expect(fixture.unsubscribe).not.toHaveBeenCalled();
});
