/**
 * GamesSection — the game-by-game view on real payloads: the picker
 * (newest first, keyboard-operable, aria-pressed), the per-game MMR lines
 * (never a "next game" change without a later game), both build orders
 * with cosmetic lines filtered, and the lazily loaded macro timeline,
 * whose roster lists real buildings and upgrades and which never fetches.
 */
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { buildReportGames } from "@/lib/instant/reportGames";
import { bare, ladderPair, realWin } from "@/lib/instant/__tests__/fixtures/reportGames";
import { GamesSection } from "../report/GamesSection";
import { BUILD_TIMES_NOTE, GameMmr, NEXT_GAME_MMR_NOTE, gameTitle } from "../report/GameDetail";
import { mmrPairLabel } from "../report/GameList";
import { nextHover } from "../report/OfflineMacroChart";

// MOCK: a switch that makes the chart's series builder throw, to prove a
// chart failure stays inside the chart. Off, the real builder runs.
const chartFault = vi.hoisted(() => ({ on: false }));
vi.mock("@/components/analyzer/macro/activeArmyLayout", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/components/analyzer/macro/activeArmyLayout")>();
  return {
    ...actual,
    buildSeries: (...args: Parameters<typeof actual.buildSeries>) => {
      if (chartFault.on) throw new Error("chart exploded");
      return actual.buildSeries(...args);
    },
  };
});
// MOCK: next/image needs the Next runtime; a bare <img> is equivalent here.
vi.mock("next/image", () => ({
  default: (props: { src?: string; alt?: string }) => (
    // eslint-disable-next-line @next/next/no-img-element
    <img src={String(props.src ?? "")} alt={props.alt ?? ""} />
  ),
}));

const CHART_BOX = { width: 600, height: 220 };

// MOCK: fetch is replaced by a spy so any request would be caught.
const fetchSpy = vi.fn();

beforeEach(() => {
  chartFault.on = false;
  vi.stubGlobal("fetch", fetchSpy);
  // MOCK: jsdom has no ResizeObserver; report a fixed chart box.
  vi.stubGlobal(
    "ResizeObserver",
    class {
      constructor(private callback: ResizeObserverCallback) {}
      observe(target: Element) {
        const rect = new DOMRect(0, 0, CHART_BOX.width, CHART_BOX.height);
        this.callback([{ target, contentRect: rect } as ResizeObserverEntry], this as unknown as ResizeObserver);
      }
      unobserve() {}
      disconnect() {}
    },
  );
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  fetchSpy.mockReset();
});

function threeGames() {
  const [older, newer] = ladderPair();
  return buildReportGames([older, realWin(), newer]);
}

describe("GamesSection picker", () => {
  it("shows the newest game by default and switches on click", async () => {
    render(<GamesSection games={threeGames()} />);
    const buttons = within(screen.getByRole("list", { name: "Your games" })).getAllByRole("button");
    expect(buttons).toHaveLength(3);
    expect(buttons.map((b) => b.getAttribute("aria-pressed"))).toEqual(["true", "false", "false"]);
    expect(buttons[0].textContent).toContain("PvZ");
    expect(buttons[0].textContent).toContain("You 5,326 · Opp 5,118 pre-game MMR");
    const detail = within(screen.getByTestId("report-game-detail"));
    expect(detail.getByRole("heading", { name: "PvZ vs Squirtuoz" })).toBeTruthy();

    fireEvent.click(buttons[2]);
    expect(buttons.map((b) => b.getAttribute("aria-pressed"))).toEqual(["false", "false", "true"]);
    // The deferred detail render has caught up with the pressed button.
    const shown = screen.getByTestId("report-game-detail");
    expect(shown.parentElement?.getAttribute("aria-busy")).toBe("false");
    expect(within(shown).getByRole("heading", { name: "TvZ vs GivePower" })).toBeTruthy();
    expect(screen.getByText(/^Showing TvZ vs GivePower Winter Madness LE/)).toBeTruthy();
    await screen.findByRole("img", { name: /Army value/ });
  });

  it("uses real buttons, so the keyboard can reach and press every game", () => {
    render(<GamesSection games={threeGames()} />);
    const second = within(screen.getByRole("list", { name: "Your games" })).getAllByRole("button")[1];
    second.focus();
    expect(document.activeElement).toBe(second);
    expect(second.getAttribute("type")).toBe("button");
    fireEvent.click(second);
    expect(second.getAttribute("aria-pressed")).toBe("true");
  });

  it("keeps the picked game when the report data is re-read", () => {
    const { rerender } = render(<GamesSection games={threeGames()} />);
    fireEvent.click(within(screen.getByRole("list", { name: "Your games" })).getAllByRole("button")[2]);
    // Same games, new objects: what the page gets once they are stored.
    rerender(<GamesSection games={threeGames()} />);
    const buttons = within(screen.getByRole("list", { name: "Your games" })).getAllByRole("button");
    expect(buttons.map((b) => b.getAttribute("aria-pressed"))).toEqual(["false", "false", "true"]);
    expect(within(screen.getByTestId("report-game-detail")).getByRole("heading", { name: "TvZ vs GivePower" })).toBeTruthy();
  });

  it("drops the picker for a single game and renders nothing without games", () => {
    const { container, rerender } = render(<GamesSection games={buildReportGames([realWin()])} />);
    expect(screen.queryByRole("list", { name: "Your games" })).toBeNull();
    expect(screen.getByTestId("report-game-detail")).toBeTruthy();
    rerender(<GamesSection games={[]} />);
    expect(container.innerHTML).toBe("");
  });
});

describe("GamesSection MMR", () => {
  it("shows the pre-game gap and the real change up to the next game", () => {
    const games = threeGames();
    render(<GamesSection games={games} />);
    const rows = within(screen.getByRole("list", { name: "Your games" })).getAllByRole("button");
    fireEvent.click(rows[2]);
    const mmr = within(screen.getByTestId("report-game-mmr"));
    expect(mmr.getByText("· favored by 109")).toBeTruthy();
    expect(mmr.getByText("−32")).toBeTruthy();
    expect(mmr.getByText(NEXT_GAME_MMR_NOTE)).toBeTruthy();
  });

  it("never shows a next-game change for the latest game of a queue", () => {
    render(<GamesSection games={threeGames()} />);
    const rows = within(screen.getByRole("list", { name: "Your games" })).getAllByRole("button");
    fireEvent.click(rows[1]);
    const mmr = within(screen.getByTestId("report-game-mmr"));
    expect(mmr.getByText("· favored by 45")).toBeTruthy();
    expect(mmr.queryByText(/by your next game/)).toBeNull();
    expect(mmr.queryByText(NEXT_GAME_MMR_NOTE)).toBeNull();
  });

  it("labels an underdog, and hides the block without MMR data", () => {
    render(<GameMmr mmr={{ my: 5000, opp: 5090, gap: -90 }} next={null} />);
    expect(screen.getByText("· underdog by 90")).toBeTruthy();
    cleanup();
    const { container } = render(<GameMmr mmr={null} next={null} />);
    expect(container.innerHTML).toBe("");
    expect(mmrPairLabel(null)).toBeNull();
    expect(gameTitle({ matchup: null, opponentName: null })).toBe("Game");
  });
});

describe("GamesSection builds and chart", () => {
  it("renders both build orders with cosmetic lines filtered", () => {
    render(<GamesSection games={buildReportGames([realWin()])} />);
    const mine = within(screen.getByTestId("build-column-me"));
    const theirs = within(screen.getByTestId("build-column-opp"));
    expect(mine.getByText("You — PvZ - Adept Glaives (Robo)")).toBeTruthy();
    expect(theirs.getByText("Squirtuoz — ZvP - Speedling Flood")).toBeTruthy();
    expect(theirs.getAllByText("Spawning Pool").length).toBeGreaterThan(0);
    const columns = screen.getByTestId("report-build-orders");
    expect(columns.textContent).not.toMatch(/Reward|Beacon|Spray/);
  });

  it("says a side is empty instead of inventing a build", () => {
    // Derived: the real game with only reward dances left in your log.
    const game = { ...realWin(), buildLog: ["[0:00] RewardDanceStalker"], myBuild: null };
    render(<GamesSection games={buildReportGames([game])} />);
    expect(within(screen.getByTestId("build-column-me")).getByText("No build events were parsed from this replay.")).toBeTruthy();
    expect(within(screen.getByTestId("build-column-opp")).getAllByText("Spawning Pool").length).toBeGreaterThan(0);
  });

  it("hides the build orders when neither side has an event", () => {
    const game = bare({ buildLog: ["[0:00] RewardDanceStalker"], myRace: "Protoss" });
    render(<GamesSection games={buildReportGames([game])} />);
    expect(screen.getByTestId("report-game-detail")).toBeTruthy();
    expect(screen.queryByTestId("report-build-orders")).toBeNull();
    expect(screen.queryByText(BUILD_TIMES_NOTE)).toBeNull();
  });

  it("loads the macro chart lazily and never fetches anything", async () => {
    render(<GamesSection games={buildReportGames([realWin()])} />);
    expect(screen.getByTestId("report-macro-chart")).toBeTruthy();
    expect(await screen.findByRole("img", { name: /Army value/ })).toBeTruthy();
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("lists real buildings and upgrades in the roster, from the local build order", async () => {
    render(<GamesSection games={buildReportGames([realWin()])} />);
    const roster = await screen.findByRole("region", { name: /^You composition at/ });
    expect(roster.textContent).not.toMatch(/Buildings unavailable|No upgrades yet/);
    expect(within(roster).getByRole("button", { name: "Nexus — 3 on the field" })).toBeTruthy();
    expect(within(roster).getByRole("button", { name: "Resonating Glaives — Researched" })).toBeTruthy();
  });

  it("keeps a chart failure inside the chart", async () => {
    chartFault.on = true;
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    render(<GamesSection games={buildReportGames([realWin()])} />);
    expect(await screen.findByText(/Failed to render the macro timeline/)).toBeTruthy();
    expect(screen.getByTestId("report-build-orders")).toBeTruthy();
  });

  it("hides the chart when the game has no stats samples", () => {
    const win = realWin();
    const noSamples = { ...win, macroBreakdown: { ...(win.macroBreakdown ?? {}), stats_events: [] } };
    render(<GamesSection games={buildReportGames([noSamples])} />);
    expect(screen.queryByTestId("report-macro-chart")).toBeNull();
    expect(screen.getByTestId("report-build-orders")).toBeTruthy();
  });
});

describe("OfflineMacroChart selection rule", () => {
  it("previews on hover until a click or tap locks a time", () => {
    const idle = { time: null, sticky: false, card: false };
    expect(nextHover(idle, { type: "hover", time: 90 })).toEqual({ time: 90, sticky: false, card: true });
    const locked = nextHover(idle, { type: "tap", time: 30 });
    expect(locked).toEqual({ time: 30, sticky: true, card: true });
    expect(nextHover(locked, { type: "hover", time: 90 })).toBe(locked);
    expect(nextHover(locked, { type: "leave" })).toBe(locked);
    expect(nextHover(locked, { type: "tap", time: 60 })).toEqual({ time: 60, sticky: true, card: true });
  });

  it("closes the card and releases the lock on a tap off the chart, keeping the time", () => {
    const locked = { time: 30, sticky: true, card: true };
    const dismissed = nextHover(locked, { type: "dismiss" });
    expect(dismissed).toEqual({ time: 30, sticky: false, card: false });
    expect(nextHover(dismissed, { type: "dismiss" })).toBe(dismissed);
    // Hover previews resume, and bring the card back.
    expect(nextHover(dismissed, { type: "hover", time: 90 })).toEqual({ time: 90, sticky: false, card: true });
  });
});
