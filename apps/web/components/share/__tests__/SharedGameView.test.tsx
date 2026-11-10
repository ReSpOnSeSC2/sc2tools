import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import type { SharedGameAnalysis } from "@/lib/sharedGame";

const h = vi.hoisted(() => ({
  fetch: vi.fn(async () => new Response(null, { status: 204 })),
  host: vi.fn(),
  publicApi: vi.fn(),
}));
vi.mock("@clerk/nextjs", () => ({ useAuth: () => ({ userId: null, isLoaded: true, isSignedIn: false, getToken: async () => null }) }));
vi.mock("@/lib/clientApi", () => ({ API_BASE: "http://local-api" }));
vi.mock("@/lib/usePublicApi", () => ({ usePublicApi: (path: string | null) => h.publicApi(path) }));
vi.mock("@/lib/segmentedPlayback", () => ({ sanitizePlaybackManifest: (raw: unknown) => raw }));
vi.mock("@/components/analyzer/game/replay/SegmentedReplayHost", () => ({
  SegmentedReplayHost: (props: Record<string, unknown>) => { h.host(props); return <div data-testid="segmented-host" />; },
}));
vi.mock("@/components/analyzer/game/InteractiveTimeline", () => ({ InteractiveTimeline: () => <div data-testid="timeline" /> }));
vi.mock("@/components/analyzer/game/MechanicsPanel", () => ({ MechanicsPanel: () => <p>Mechanics</p> }));
vi.mock("@/components/analyzer/game/BuildOrderColumns", () => ({ BuildOrderColumns: () => <p>Build orders</p> }));
import { SharedGameView } from "../SharedGameView";

const TOKEN = "AbCdEfGhIjKlMnOp";
const DATA: SharedGameAnalysis = {
  game: {
    matchup: "PvZ", myRace: "Protoss", oppRace: "Zerg", map: "Alcyone LE", result: "Win", durationSec: 640,
    playedOn: "2026-09-01", myBuild: "PvZ - Blink All-in", oppStrategy: "Zerg - Roach Ravager", macroScore: 61,
    apm: 150, spq: 70, playerLabel: "Protoss player", playerMmr: 4100, playerBand: null,
    opponentLabel: "Opponent (Zerg, ~4,100 MMR)", opponentMmr: 4100, opponentBand: null, matchFormat: "1v1", playerCount: 2,
  },
  macroBreakdown: { ok: true, macro_score: 61, stats_events: [{ time: 60, army_value: 100 }], opp_stats_events: [] } as unknown as SharedGameAnalysis["macroBreakdown"],
  buildOrder: null,
  playback: { mode: "segmented" },
  benchmark: {
    league: "Diamond", matchup: "PvZ", n: 400, updatedAt: "2026-11-01T00:00:00Z",
    metrics: { macroScore: { n: 400, deciles: [20, 30, 40, 45, 50, 55, 60, 70, 80] } },
  },
};

beforeEach(() => {
  h.fetch.mockClear(); h.host.mockClear();
  h.publicApi.mockImplementation((path: string | null) => ({
    data: path?.endsWith("/map-playback/manifest") ? { artifactId: "a".repeat(64), gameLength: 640, segments: [] } : undefined,
    isLoading: false,
  }));
  vi.stubGlobal("fetch", h.fetch);
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

describe("SharedGameView", () => {
  it("shows the redacted game, counts one view and never links into the owner's app", async () => {
    const view = render(<SharedGameView token={TOKEN} data={DATA} />);
    expect(screen.getByRole("heading", { level: 1, name: "PvZ on Alcyone LE" })).toBeTruthy();
    expect(screen.getByText("Protoss player vs Opponent (Zerg, ~4,100 MMR)")).toBeTruthy();
    expect(screen.getByText("Player: PvZ - Blink All-in")).toBeTruthy();
    expect(await screen.findByRole("heading", { name: "Map replay" })).toBeTruthy();
    expect(screen.getByRole("img", { name: /Macro score: band = opponent's league, Diamond PvZ/ })).toBeTruthy();
    await waitFor(() => expect(h.fetch).toHaveBeenCalledTimes(1));
    expect(h.fetch).toHaveBeenCalledWith(`http://local-api/v1/shares/${TOKEN}/views`, expect.objectContaining({ method: "POST" }));
    view.rerender(<SharedGameView token={TOKEN} data={DATA} />);
    expect(h.fetch).toHaveBeenCalledTimes(1);
    expect(view.container.querySelector('a[href^="/app"]')).toBeNull();
  });

  it("plays the recorded replay through the share's own grant, storage links first", async () => {
    render(<SharedGameView token={TOKEN} data={DATA} initialTimeSec={312} />);
    await screen.findByTestId("segmented-host");
    expect(h.publicApi).toHaveBeenCalledWith(`/v1/shares/${TOKEN}/map-playback/manifest`);
    const props = h.host.mock.calls.at(-1)![0] as Record<string, any>;
    expect(props.anonymous).toBe(true);
    expect(props.initialTimeSec).toBe(312);
    expect(props.myName).toBe("Protoss player");
    expect(props.oppName).toBe("Opponent (Zerg, ~4,100 MMR)");
    expect(props.segmentPath("b".repeat(64), 3)).toBe(`/v1/shares/${TOKEN}/map-playback/artifacts/${"b".repeat(64)}/segments/3`);
    expect(props.segmentLinkPath("b".repeat(64), 3)).toBe(`/v1/shares/${TOKEN}/map-playback/artifacts/${"b".repeat(64)}/segments/3/link`);
  });
});
