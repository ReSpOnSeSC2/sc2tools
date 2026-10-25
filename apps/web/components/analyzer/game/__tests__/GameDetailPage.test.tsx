import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import type { BuildEditorModalProps } from "@/components/builds/editor";
import type { MacroBreakdownData } from "@/components/analyzer/macro/MacroBreakdownPanel.types";
import type { GameVodLinksResponse } from "@/components/analyzer/GameStreamLinks";
import { GameDetailPage } from "../GameDetailPage";
import type { GameBuildOrderResponse, GameSummary } from "../types";
import type { GameIntentState } from "@/lib/buildIntent";
import { rawPayload } from "../replay/__tests__/fixtures";

const useApiMock = vi.fn();
const apiCallMock = vi.fn();
const getTokenMock = vi.fn(async () => "test-token");
const routerReplaceMock = vi.fn();
const editorHarness = vi.hoisted(() => ({ props: null as BuildEditorModalProps | null }));

// Compile the real lazy chunks before assertions; bundler work is not UI latency.
beforeAll(async () => { await Promise.all([import("../GameMacroSection"), import("../BuildOrderColumns"), import("../GameStoryCard")]); });

vi.mock("@clerk/nextjs", () => ({
  useAuth: () => ({ getToken: getTokenMock, isLoaded: true, isSignedIn: true }),
}));

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), replace: routerReplaceMock }),
}));

vi.mock("@/components/builds/editor", () => ({
  BuildEditorModal: (props: BuildEditorModalProps) => {
    editorHarness.props = props;
    return props.open ? <div role="dialog" aria-label="Build editor" /> : null;
  },
}));

vi.mock("@/lib/clientApi", () => ({
  useApi: (...args: unknown[]) => useApiMock(...args),
  apiCall: (...args: unknown[]) => apiCallMock(...args),
}));

// next/image needs the Next runtime; a bare <img> is equivalent here.
vi.mock("next/image", () => ({
  default: (props: { src?: string; alt?: string }) => (
    // eslint-disable-next-line @next/next/no-img-element
    <img src={String(props.src ?? "")} alt={props.alt ?? ""} />
  ),
}));

// recharts' ResponsiveContainer observes its parent unconditionally;
// jsdom has no ResizeObserver.
class ResizeObserverStub {
  observe() {}
  unobserve() {}
  disconnect() {}
}
(globalThis as { ResizeObserver?: unknown }).ResizeObserver =
  (globalThis as { ResizeObserver?: unknown }).ResizeObserver ||
  ResizeObserverStub;

afterEach(() => {
  cleanup();
  useApiMock.mockReset();
  apiCallMock.mockReset();
  routerReplaceMock.mockReset();
  editorHarness.props = null;
  getTokenMock.mockClear();
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

const SLIM: GameSummary = {
  gameId: "g1",
  date: "2026-07-01T10:00:00Z",
  result: "Defeat",
  map: "Ephemeron",
  myRace: "Zerg",
  myBuild: "Roach Allin",
  myMmr: 4100,
  durationSec: 700,
  macroScore: 44,
  spq: 71,
  opponent: {
    displayName: "Foe",
    race: "Terran",
    mmr: 4200,
    strategy: "Terran - 2 Rax",
  },
};

const MACRO: MacroBreakdownData = {
  ok: true,
  macro_score: 44,
  race: "Zerg",
  game_length_sec: 700,
  raw: {
    sq: 71,
    supply_blocked_seconds: 40,
    supply_block_windows: [{ start: 222, end: 262, blocked_sec: 40 }],
    injects_actual: 10,
    injects_expected: 20,
    mineral_float_spikes: 2,
  },
  all_leaks: [],
  stats_events: [
    { time: 10, army_value: 0, minerals_current: 50, food_used: 13, food_made: 14 },
    { time: 300, army_value: 2000, minerals_current: 400, food_used: 90, food_made: 98 },
    { time: 330, army_value: 400, minerals_current: 600, food_used: 60, food_made: 98 },
    { time: 690, army_value: 350, minerals_current: 900, food_used: 55, food_made: 98 },
  ],
  opp_stats_events: [
    { time: 10, army_value: 0 },
    { time: 300, army_value: 1900 },
    { time: 330, army_value: 1750 },
    { time: 690, army_value: 2400 },
  ],
};

const BUILD_ORDER = {
  ok: true,
  game_id: "g1",
  my_build: "Roach Allin",
  my_race: "Zerg",
  opp_strategy: "Terran - 2 Rax",
  opponent: "Foe",
  opp_race: "Terran",
  map: "Ephemeron",
  result: "Defeat",
  events: [
    {
      time: 17,
      time_display: "0:17",
      name: "SpawningPool",
      display: "Spawning Pool",
      race: "Zerg",
      category: "building",
      tier: 1,
      is_building: true,
    },
  ],
  early_events: [],
  opp_events: [
    {
      time: 45,
      time_display: "0:45",
      name: "Barracks",
      display: "Barracks",
      race: "Terran",
      category: "building",
      tier: 1,
      is_building: true,
    },
  ],
  opp_early_events: [],
  my_status: "ok" as const,
  opp_status: "ok" as const,
};

function mockEndpoints({
  slim = SLIM,
  macro = MACRO,
  slimError,
  vodLinks,
  intent,
  playback = false,
  buildOrder = BUILD_ORDER,
}: {
  slim?: GameSummary;
  macro?: MacroBreakdownData | null;
  slimError?: { status: number; message: string };
  vodLinks?: GameVodLinksResponse;
  intent?: GameIntentState;
  playback?: boolean;
  buildOrder?: GameBuildOrderResponse;
} = {}) {
  const encodedId = encodeURIComponent(slim.gameId);
  useApiMock.mockImplementation((path: string | null) => {
    if (!path) return { data: undefined, error: undefined, isLoading: false };
    if (playback && path === `/v1/games/${encodedId}/map-playback/manifest`) {
      return { data: rawPayload(), error: undefined, isLoading: false, mutate: vi.fn() };
    }
    if (path.startsWith(`/v1/games/${encodedId}/build-intent?include=options#`)) {
      return { data: intent, error: undefined, isLoading: false, mutate: vi.fn() };
    }
    if (path === `/v1/games/${encodedId}`) {
      return slimError
        ? { data: undefined, error: slimError, isLoading: false }
        : { data: slim, error: undefined, isLoading: false };
    }
    if (path === `/v1/games/${encodedId}/macro-breakdown`) {
      return macro
        ? { data: macro, error: undefined, isLoading: false }
        : {
            data: undefined,
            error: { status: 404, code: "macro_not_computed", message: "Not found." },
            isLoading: false,
          };
    }
    if (path === `/v1/games/${encodedId}/build-order`) {
      return { data: buildOrder, error: undefined, isLoading: false };
    }
    if (path === `/v1/games/vod-links?gameId=${encodedId}`) {
      return { data: vodLinks, error: undefined, isLoading: false };
    }
    return { data: undefined, error: undefined, isLoading: false };
  });
}

describe("GameDetailPage", () => {
  it("uses the recorded upgrade completion rather than research start and omits unknown completion times", () => {
    vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue(null);
    mockEndpoints({ playback: true, buildOrder: { ...BUILD_ORDER, events: [
      { time: 100, complete_time: 300, name: "MetabolicBoost", display: "Metabolic Boost", category: "upgrade" },
      { time: 50, name: "UnknownTiming", display: "Unknown timing", category: "upgrade" },
    ] } });
    const view = render(<GameDetailPage gameId="g1" initialTimeSec={150} />);
    const bar = screen.getByTestId("replay-top-bar");
    expect(within(bar).queryByText("Metabolic Boost")).toBeNull();
    view.rerender(<GameDetailPage gameId="g1" initialTimeSec={300} />);
    expect(within(bar).getByText("Metabolic Boost")).toBeTruthy();
    expect(within(bar).queryByText("Unknown timing")).toBeNull();
  });
  it("seeks and reveals the mounted replay from a supply block, with banked resources and stable timestamp navigation", async () => {
    const canvas = vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue(null);
    window.history.replaceState(null, "", "/app/game/g1?from=replays");
    mockEndpoints({ playback: true, macro: { ...MACRO, stats_events: MACRO.stats_events?.map((sample) => ({ ...sample, vespene_current: 75 })) } });
    const view = render(<GameDetailPage gameId="g1" />);
    const stage = await screen.findByTestId("replay-stage");
    const scroll = vi.fn(); stage.scrollIntoView = scroll;
    vi.spyOn(stage, "getBoundingClientRect").mockReturnValue(new DOMRect(0, 1400, 600, 400));
    fireEvent.click(within(screen.getByTestId("mechanics-panel")).getByRole("button", { name: "Watch the replay at 3:42" }));
    await waitFor(() => expect(within(stage).getByLabelText("Game clock 3:42 of 10:00")).toBeTruthy());
    expect(scroll).toHaveBeenCalledOnce(); expect(document.activeElement).toBe(stage);
    expect(stage.hasAttribute("data-clock-seek")).toBe(true);
    expect(within(screen.getByTestId("mechanics-panel")).getByRole("button", { name: "Watch the replay at 3:42" }).getAttribute("aria-current")).toBe("step");
    expect(within(stage).getByTitle(/You.*minerals banked/)).toBeTruthy();
    await waitFor(() => expect(routerReplaceMock).toHaveBeenCalledWith("/app/game/g1?from=replays&t=222", { scroll: false }));
    view.rerender(<GameDetailPage gameId="g1" initialTimeSec={60} />);
    expect(screen.getByTestId("replay-stage")).toBe(stage);
    await waitFor(() => expect(within(stage).getByLabelText("Game clock 1:00 of 10:00")).toBeTruthy());
    view.unmount(); canvas.mockRestore(); window.history.replaceState(null, "", "/");
  });
  it("links only the opponent metadata while the descriptive heading stays plain", () => {
    mockEndpoints({ slim: { ...SLIM, opponent: { ...SLIM.opponent, pulseId: "1-S2-1-99" } } });
    render(<GameDetailPage gameId="g1" />);
    const heading = screen.getByRole("heading", { level: 1, name: "ZvT vs Foe on Ephemeron" });
    expect(heading.querySelector("a")).toBeNull();
    const link = within(heroHeader()).getByRole("link", { name: "Terran Foe" });
    expect(link.getAttribute("href")).toBe("/app/opponents/1-S2-1-99");
    const time = heroHeader().querySelector("time");
    expect(time?.getAttribute("datetime")).toBe(SLIM.date);
    expect(time?.getAttribute("title")).toBe(new Date(SLIM.date!).toLocaleString());
  });

  it("omits absent header facts and keeps the fallback title", () => {
    mockEndpoints({ slim: { gameId: "g1" } });
    render(<GameDetailPage gameId="g1" />);
    const header = heroHeader();
    expect(within(header).getByRole("heading", { level: 1, name: "Game details" })).toBeTruthy();
    expect(within(header).queryByText("Length")).toBeNull();
    expect(within(header).queryByText("MMR")).toBeNull();
    expect(within(header).queryByText("Opponent", { exact: true })).toBeNull();
  });

  it("shows the known MMR with an honest missing opponent value", () => {
    mockEndpoints({ slim: { ...SLIM, opponent: { ...SLIM.opponent, mmr: null } } });
    render(<GameDetailPage gameId="g1" />);
    const mmr = within(heroHeader()).getByText("MMR").parentElement;
    expect(mmr?.textContent).toMatch(/4100\s*vs\s*—/);
  });

  it("opens a review request for the current owner's 1v1 game", () => {
    vi.stubEnv("NEXT_PUBLIC_REVIEWS_ENABLED", "on");
    mockEndpoints({ slim: { ...SLIM, matchFormat: "1v1", playerCount: 2 } });
    render(<GameDetailPage gameId="g1" />);
    const review = screen.getByRole("button", { name: "Ask for a review" });
    expect(screen.getByRole("toolbar", { name: "Game actions" }).contains(review)).toBe(true);
    fireEvent.click(review);
    expect(screen.getByRole("dialog", { name: "Ask for a replay review" })).toBeTruthy();
    expect(screen.getByText("Game length 11:40")).toBeTruthy();
  });

  it.each([
    { matchFormat: "team" as const, playerCount: 4 },
    { matchFormat: "ffa" as const, playerCount: 4 },
    { matchFormat: "other" as const, playerCount: 2 },
    { playerCount: 4 },
  ])("does not offer to post a multiplayer or unsupported-format game: %j", (format) => {
    vi.stubEnv("NEXT_PUBLIC_REVIEWS_ENABLED", "on");
    mockEndpoints({ slim: { ...SLIM, ...format } });
    render(<GameDetailPage gameId="g1" />);
    expect(screen.queryByRole("button", { name: "Ask for a review" })).toBeNull();
    expect(screen.getByRole("toolbar", { name: "Game actions" })).toBeTruthy();
  });

  it("applies a deep-link time after async game data loads without resetting later scrubs", () => {
    useApiMock.mockReturnValue({ isLoading: true });
    const view = render(<GameDetailPage gameId="g1" initialTimeSec={360} />);
    expect(screen.getByLabelText("Loading game")).toBeTruthy();
    mockEndpoints();
    view.rerender(<GameDetailPage gameId="g1" initialTimeSec={360} />);
    const slider = screen.getByRole("slider", { name: "Scrub game time" }) as HTMLInputElement;
    expect(slider.value).toBe("360");
    fireEvent.change(slider, { target: { value: "200" } });
    view.rerender(<GameDetailPage gameId="g1" initialTimeSec={360} />);
    expect(slider.value).toBe("200");
  });

  it("clamps the initial timestamp and resets for another timestamp or game", () => {
    mockEndpoints();
    const view = render(<GameDetailPage gameId="g1" initialTimeSec={900} />);
    const slider = () => screen.getByRole("slider", { name: "Scrub game time" }) as HTMLInputElement;
    expect(slider().value).toBe("700");
    fireEvent.change(slider(), { target: { value: "200" } });
    view.rerender(<GameDetailPage gameId="g1" initialTimeSec={240} />);
    expect(slider().value).toBe("240");
    mockEndpoints({ slim: { ...SLIM, gameId: "g2" } });
    view.rerender(<GameDetailPage gameId="g2" />);
    expect(slider().value).toBe("0");
  });

  it("renders header, macro workspace, mechanics and the loss autopsy on a defeat", async () => {
    mockEndpoints();
    const { container } = render(<GameDetailPage gameId="g1" />);

    // Header facts.
    expect(screen.getByText("Defeat")).toBeTruthy();
    expect(screen.getByRole("heading", { level: 1, name: "ZvT vs Foe on Ephemeron" })).toBeTruthy();
    const heroArtwork = container.querySelector(
      'header [data-map-artwork="image"] img',
    );
    expect(heroArtwork?.getAttribute("src")).toContain("Ephemeron%20LE");
    expect(heroArtwork?.getAttribute("loading")).toBe("eager");
    expect(screen.getByText("Roach Allin")).toBeTruthy();
    expect(screen.getByText("Terran - 2 Rax")).toBeTruthy();

    // Centerpiece timeline with scrubber + readout.
    expect(await screen.findByRole("button", { name: "Army" })).toBeTruthy();
    expect(screen.getByLabelText("Scrub game time")).toBeTruthy();
    expect(screen.getByTestId("game-clock-readout")).toBeTruthy();

    // Mechanics: race-aware inject stat from the breakdown payload.
    expect(screen.getByTestId("mechanics-panel")).toBeTruthy();
    expect(within(screen.getByTestId("mechanics-panel")).getByText("Inject Efficiency")).toBeTruthy();

    // Loss → autopsy visible with at least one clickable timestamp.
    expect(screen.getByTestId("loss-autopsy-card")).toBeTruthy();
    expect(screen.getByRole("heading", { name: "Why you lost" })).toBeTruthy();
    expect(screen.getByText("Missed injects")).toBeTruthy();
    expect(
      within(screen.getByTestId("loss-autopsy-card")).getByRole("button", { name: "Watch the replay at 3:42" }),
    ).toBeTruthy();

    // Build orders, both sides.
    expect(await screen.findByText("Spawning Pool")).toBeTruthy();
    expect(screen.getByText("Barracks")).toBeTruthy();
  });

  it("replaces the win placeholder with a replay-derived story", async () => {
    mockEndpoints({ slim: { ...SLIM, result: "Victory" } });
    render(<GameDetailPage gameId="g1" />);
    expect(screen.getByText("Victory")).toBeTruthy();
    expect(screen.queryByTestId("loss-autopsy-card")).toBeNull();
    expect(screen.queryByText("Why you lost")).toBeNull();
    expect(await screen.findByRole("heading", { name: "Game story" })).toBeTruthy();
    expect(screen.queryByText(/You won this one/)).toBeNull();
  });

  it("uses the same mounted replay clock for a game-story highlight", async () => {
    vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue(null);
    mockEndpoints({ slim: { ...SLIM, result: "Victory" }, playback: true });
    render(<GameDetailPage gameId="g1" />);
    const stage = await screen.findByTestId("replay-stage");
    const peak = await screen.findByRole("button", { name: /Peak army lead.*5:00/ });
    fireEvent.click(peak);
    await waitFor(() => expect(within(stage).getByLabelText("Game clock 5:00 of 10:00")).toBeTruthy());
    expect(screen.getByTestId("replay-stage")).toBe(stage);
    expect(document.activeElement).toBe(stage);
  });

  it("uses replay build-order races for the exact Ghost matchup", async () => {
    mockEndpoints({
      slim: {
        ...SLIM,
        myRace: "Protoss",
        opponent: { ...SLIM.opponent!, race: "Zerg" },
      },
    });
    render(<GameDetailPage gameId="g1" />);

    // BUILD_ORDER says Zerg vs Terran. Those replay-derived values must win
    // over the conflicting slim summary so the build cannot enter PvZ.
    const myColumn = await screen.findByTestId("build-column-me");
    expect(within(myColumn).getByRole("button", { name: "Use as Ghost Build target" }).title).toContain("ZvT");
    expect(within(screen.getByTestId("build-column-opp")).getByRole("button", { name: "Use as Ghost Build target" }).title).toContain("TvZ");
    expect(screen.queryByRole("button", { name: "Save for PvZ" })).toBeNull();
  });

  it("degrades to build logs when the macro breakdown was never computed", async () => {
    mockEndpoints({ macro: null });
    render(<GameDetailPage gameId="g1" />);
    // Timeline can't render without stats_events — explanatory empty state.
    expect(await screen.findByText("No macro breakdown for this game")).toBeTruthy();
    // Mechanics panel still shows what the slim row carries (SQ 71).
    expect(screen.getByTestId("mechanics-panel")).toBeTruthy();
    expect(screen.getByText("71")).toBeTruthy();
    // Build orders survive untouched.
    expect(screen.getByText("Spawning Pool")).toBeTruthy();
    expect(screen.getByText("Barracks")).toBeTruthy();
  });

  it("returns to the originating opponent dossier when context is present", () => {
    mockEndpoints();
    render(
      <GameDetailPage
        gameId="g1"
        opponentContext={{ pulseId: "1-S2-1-99", displayName: "Foe" }}
      />,
    );

    const back = screen.getByRole("link", { name: "Back to Foe" });
    expect(back.getAttribute("href")).toBe("/app/opponents/1-S2-1-99");
  });

  it("shows a branded not-found state with a back link on 404", () => {
    mockEndpoints({ slimError: { status: 404, message: "Not found." } });
    render(<GameDetailPage gameId="g1" />);
    expect(screen.getByText("Game not found")).toBeTruthy();
    const back = screen.getByRole("link", { name: /back to dashboard/i });
    expect(back.getAttribute("href")).toBe("/app");
  });

  it("shows timestamped POV stream controls in the game hero", () => {
    mockEndpoints({
      slim: {
        ...SLIM,
        replayFile: {
          storedAt: "2026-08-11T16:30:00.000Z",
          sizeBytes: 128_000,
        },
      },
      vodLinks: {
        configuredPlatforms: ["twitch"],
        linksByGameId: {
          g1: [
            {
              platform: "twitch",
              perspective: "opponent",
              playerName: "Foe",
              url: "https://www.twitch.tv/videos/99",
              offsetSec: 65,
            },
          ],
        },
      },
    });
    render(<GameDetailPage gameId="g1" />);

    const link = screen.getByRole("link", {
      name: "Watch VOD",
    });
    expect(link.getAttribute("href")).toBe(
      "https://www.twitch.tv/videos/99?t=0h1m5s",
    );
    expect(link.getAttribute("title")).toBe("Opponent · Twitch · 1:05 · Foe");
    expect(link.className).toContain("h-9");

    const download = screen.getByRole("button", { name: "Download replay" });
    expect(download.textContent).toContain("Download replay");
    expect(download.getAttribute("title")).toContain("125 KB");
    const actionLine = screen.getByRole("toolbar", { name: "Game actions" });
    const actions = Array.from(actionLine.querySelectorAll("a,button")).filter(action => !action.closest("details"));
    expect(within(actionLine).getByText("Export")).toBeTruthy();
    expect(actions).toEqual([screen.getByRole("button", { name: "Share this game as an image" }), download, link]);
    expect(useApiMock).toHaveBeenCalledWith(
      "/v1/games/vod-links?gameId=g1",
      { revalidateOnFocus: false, shouldRetryOnError: false },
    );
  });

  it("headlines a confirmed check-in with a Planned badge naming the replay's label", () => {
    mockEndpoints({ intent: checkinState({ status: "confirmed", applied: true }) });
    render(<GameDetailPage gameId="g1" />);

    const header = heroHeader();
    expect(within(header).getByText("Roach Ling Flood")).toBeTruthy();
    const planned = within(header).getByTestId("planned-badge");
    expect(planned.getAttribute("title")).toBe("Replay classified as Roach Allin");
    expect(screen.getByTestId("build-checkin-summary").textContent).toContain("Checked in: Roach Ling Flood");
  });

  it("falls back to the slim row's planned flag before the check-in loads", () => {
    mockEndpoints({
      slim: { ...SLIM, myBuild: "Roach Ling Flood", buildPlanned: true, detectedBuild: "Roach Allin" },
    });
    render(<GameDetailPage gameId="g1" />);
    expect(
      within(heroHeader()).getByTestId("planned-badge").getAttribute("title"),
    ).toBe("Replay classified as Roach Allin");
    expect(screen.queryByTestId("build-checkin-card")).toBeNull();
  });

  it("marks a corrected opponent build in the header and the build columns", () => {
    mockEndpoints({
      intent: checkinState({
        opponent: {
          label: "Terran - Proxy Reaper",
          status: "confirmed",
          build: {
            key: "terran-proxy-reaper",
            name: "Terran - Proxy Reaper",
            slug: null,
            source: "catalog",
          },
          applied: true,
          detected: { name: "Terran - 2 Rax", slug: null, key: "terran-2-rax" },
          suggestion: null,
          executed: false,
        },
      }),
    });
    render(<GameDetailPage gameId="g1" />);
    const header = heroHeader();
    expect(within(header).getByText("Terran - Proxy Reaper")).toBeTruthy();
    expect(within(header).queryByText("Terran - 2 Rax")).toBeNull();
    expect(within(header).getByTestId("corrected-badge").getAttribute("title")).toBe(
      "Replay classified as Terran - 2 Rax",
    );
    // The opponent column follows the correction too.
    expect(screen.getAllByText(/Terran - Proxy Reaper/).length).toBeGreaterThan(1);
  });

  it("falls back to the slim row's corrected flag before the check-in loads", () => {
    mockEndpoints({
      slim: {
        ...SLIM,
        opponent: { ...SLIM.opponent!, strategy: "Terran - Proxy Reaper" },
        oppStrategyPlanned: true,
        detectedOppStrategy: "Terran - 2 Rax",
      },
    });
    render(<GameDetailPage gameId="g1" />);
    expect(
      within(heroHeader()).getByTestId("corrected-badge").getAttribute("title"),
    ).toBe("Replay classified as Terran - 2 Rax");
  });

  it("opens Add new build from the ?newBuild link once, then drops it from the URL", async () => {
    window.history.replaceState(null, "", "/app/game/g1?t=90&newBuild=opponent#map");
    try {
      mockEndpoints({ intent: checkinState() });
      render(<GameDetailPage gameId="g1" initialTimeSec={90} initialNewBuild="opponent" />);
      await screen.findByRole("dialog", { name: "Build editor" });
      expect(editorHarness.props).toMatchObject({
        perspective: "opponent",
        race: "Terran",
        vsRace: "Zerg",
        events: BUILD_ORDER.opp_events,
        lockMatchup: true,
        createOnly: true,
      });
      expect(routerReplaceMock).toHaveBeenCalledTimes(1);
      expect(routerReplaceMock).toHaveBeenCalledWith("/app/game/g1?t=90#map", { scroll: false });
    } finally {
      window.history.replaceState(null, "", "/");
    }
  });

  it("leaves the URL alone without a ?newBuild link", async () => {
    mockEndpoints({ intent: checkinState() });
    render(<GameDetailPage gameId="g1" />);
    await waitFor(() => expect(screen.getByTestId("build-checkin-card")).toBeTruthy());
    expect(routerReplaceMock).not.toHaveBeenCalled();
    expect(screen.queryByRole("dialog", { name: "Build editor" })).toBeNull();
  });

  it("offers the pending check-in above the timeline", () => {
    mockEndpoints({ intent: checkinState() });
    render(<GameDetailPage gameId="g1" />);
    const card = screen.getByTestId("build-checkin-card");
    expect(within(card).getByText("Needs check-in")).toBeTruthy();
    expect(within(card).getByRole("button", { name: "Confirm" })).toBeTruthy();
    expect(
      card.compareDocumentPosition(screen.getByRole("group", { name: "Game clock" }))
        & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
    expect(within(heroHeader()).queryByTestId("planned-badge")).toBeNull();
  });

  it("keeps the replay download action visible when no stream link exists", () => {
    mockEndpoints({
      slim: {
        ...SLIM,
        replayAvailable: true,
        replayFilename: "Ephemeron vs Foe.SC2Replay",
        replaySizeBytes: 256_000,
      },
    });
    render(<GameDetailPage gameId="g1" />);

    const actionLine = screen.getByRole("toolbar", { name: "Game actions" });
    const download = screen.getByRole("button", { name: "Download replay" });
    expect(actionLine.contains(download)).toBe(true);
    expect(actionLine.querySelectorAll("a")).toHaveLength(0);
    expect(download.textContent).toContain("Download replay");
  });
});

function checkinState(overrides: Partial<GameIntentState> = {}): GameIntentState {
  return {
    gameId: "g1",
    matchup: "ZvT",
    myRace: "Zerg",
    oppRace: "Terran",
    result: "Defeat",
    date: "2026-07-01T10:00:00Z",
    durationSec: 700,
    map: "Ephemeron",
    oppName: "Foe",
    eligible: true,
    ineligibleReason: null,
    status: "pending",
    applied: false,
    build: overrides.status === "confirmed"
      ? { key: "custom:roach-ling-flood", name: "Roach Ling Flood", slug: "roach-ling-flood", source: "custom" }
      : null,
    suggestion: {
      key: "custom:roach-ling-flood",
      name: "Roach Ling Flood",
      slug: "roach-ling-flood",
      source: "custom",
      reason: "rules",
      passedRules: 3,
      ruleCount: 4,
    },
    randomizer: null,
    randomizerDeviated: false,
    detected: { name: "Roach Allin", slug: null, key: null },
    executed: false,
    notes: "",
    origin: null,
    via: null,
    confirmedAt: null,
    updatedAt: null,
    prefs: { enabled: true, askAtLoading: true, askAfterGame: true },
    options: [],
    usualKey: null,
    ...overrides,
  };
}

/** The game hero: the header that carries the "My build" row. */
function heroHeader(): HTMLElement {
  const header = screen.getByText("My build").closest("header");
  if (!header) throw new Error("game header not found");
  return header;
}
