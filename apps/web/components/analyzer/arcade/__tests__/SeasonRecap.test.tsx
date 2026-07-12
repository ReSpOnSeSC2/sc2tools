import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { ToastProvider } from "@/components/ui/Toast";
import { formatMmrStory, SeasonRecap } from "../SeasonRecap";
import type { ArcadeGame } from "../types";
import { FiltersContext } from "@/lib/filterContext";
import type { LogicalSeason } from "@/lib/useSeasons";

const useArcadeDataMock = vi.fn();
vi.mock("../hooks/useArcadeData", () => ({
  useArcadeData: () => useArcadeDataMock(),
}));

afterEach(() => {
  cleanup();
  useArcadeDataMock.mockReset();
  vi.useRealTimers();
});

const JULY_12_2026 = new Date("2026-07-12T16:00:00.000Z");
const CURRENT_SEASON_67: LogicalSeason = {
  number: 67,
  battlenetId: 67,
  year: 2026,
  numberInYear: 2,
  start: "2026-04-10T00:00:00.000Z",
  end: null,
  isCurrent: true,
};

function recentGames(n: number): ArcadeGame[] {
  const now = Date.now();
  return Array.from({ length: n }, (_, i) => ({
    gameId: `g${i}`,
    date: new Date(now - i * 3_600_000).toISOString(),
    result: i % 2 === 0 ? "Victory" : "Defeat",
    myToonHandle: "1-S2-1-267727",
    myMmr: 4000 + i,
    myBuild: "PvZ - 2 Stargate Void Ray",
    oppRace: "Z",
    map: "Alcyone",
    oppPulseId: `p${i % 3}`,
    opponent: { displayName: `Foe${i % 3}` },
  })) as ArcadeGame[];
}

function interleavedAccountGames(): ArcadeGame[] {
  const start = Date.now() - 14 * 3_600_000;
  return Array.from({ length: 14 }, (_, i) => {
    const isNa = i % 2 === 0;
    return {
      gameId: `account-${i}`,
      date: new Date(start + i * 3_600_000).toISOString(),
      result: i % 3 === 0 ? "Defeat" : "Victory",
      myToonHandle: isNa ? "1-S2-1-267727" : "2-S2-1-8780508",
      myMmr: isNa ? 4000 + i * 10 : 5200 + i * 10,
      myBuild: "PvZ - 2 Stargate Void Ray",
      oppRace: "Z",
      map: "Alcyone",
    };
  });
}

function renderCard(seasons: LogicalSeason[] = []) {
  return render(
    <FiltersContext.Provider
      value={{
        filters: {},
        setFilters: () => {},
        dbRev: 0,
        bumpRev: () => {},
        seasons,
      }}
    >
      <ToastProvider>
        <SeasonRecap />
      </ToastProvider>
    </FiltersContext.Provider>,
  );
}

describe("SeasonRecap", () => {
  it("shows the unlock prompt below 10 games", () => {
    useArcadeDataMock.mockReturnValue({
      data: { games: recentGames(4) },
      loading: false,
    });
    renderCard();
    expect(screen.getByText(/unlocks at 10 games/i)).toBeTruthy();
    expect(screen.queryByRole("button", { name: /open my recap/i })).toBeNull();
  });

  it("shows a skeleton while loading with no data yet", () => {
    useArcadeDataMock.mockReturnValue({ data: null, loading: true });
    renderCard();
    // Title still renders; no CTA yet.
    expect(screen.getByText("Season Recap")).toBeTruthy();
    expect(screen.queryByRole("button", { name: /open my recap/i })).toBeNull();
  });

  it("offers the recap and opens the slide modal at >= 10 games", () => {
    useArcadeDataMock.mockReturnValue({
      data: { games: recentGames(14) },
      loading: false,
    });
    renderCard();
    const open = screen.getByRole("button", { name: /open my recap/i });
    fireEvent.click(open);

    // Modal opens on the intro slide with slide navigation present.
    expect(screen.getByText(/your season, wrapped/i)).toBeTruthy();
    expect(screen.getByRole("tablist", { name: /recap slides/i })).toBeTruthy();

    // Advancing reaches the totals slide.
    fireEvent.click(screen.getByRole("button", { name: /next/i }));
    expect(screen.getByText(/games played/i)).toBeTruthy();
  });

  it("uses authoritative Season 67 on the card and modal on July 12", () => {
    vi.useFakeTimers();
    vi.setSystemTime(JULY_12_2026);
    const dates = [
      // Before the authoritative boundary: must not inflate the recap total.
      "2026-04-01T12:00:00.000Z",
      "2026-04-10T12:00:00.000Z",
      "2026-04-20T12:00:00.000Z",
      "2026-05-01T12:00:00.000Z",
      "2026-05-15T12:00:00.000Z",
      "2026-06-01T12:00:00.000Z",
      "2026-06-15T12:00:00.000Z",
      "2026-07-01T12:00:00.000Z",
      "2026-07-05T12:00:00.000Z",
      "2026-07-10T12:00:00.000Z",
      "2026-07-12T12:00:00.000Z",
    ];
    const games = dates.map((date, index) => ({
      ...recentGames(1)[0],
      gameId: `season-67-${index}`,
      date,
    }));
    useArcadeDataMock.mockReturnValue({ data: { games }, loading: false });

    renderCard([CURRENT_SEASON_67]);

    expect(screen.getByText("Season 67")).toBeTruthy();
    expect(screen.getByText(/10 games/i)).toBeTruthy();
    expect(screen.queryByText(/Season 68/i)).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: /open my recap/i }));
    expect(screen.getAllByText("Season 67").length).toBeGreaterThanOrEqual(2);
    expect(screen.queryByText(/Season 68/i)).toBeNull();
  });

  it("labels separate NA and EU MMR slides with their account", () => {
    useArcadeDataMock.mockReturnValue({
      data: { games: interleavedAccountGames() },
      loading: false,
    });
    renderCard();
    expect(screen.getByText(/MMR tracked across 2 Battle\.net accounts/i)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: /open my recap/i }));

    fireEvent.click(screen.getByRole("button", { name: /next/i }));
    fireEvent.click(screen.getByRole("button", { name: /next/i }));
    expect(screen.getByText("MMR journey · NA 267727")).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: /next/i }));
    expect(screen.getByText("MMR journey · EU 8780508")).toBeTruthy();
  });

  it("bounds the share-card MMR story when many accounts are tracked", () => {
    const journeys = [
      { toonHandle: "1-S2-1-1", region: "NA", accountLabel: "NA 1", delta: 10 },
      { toonHandle: "2-S2-1-2", region: "EU", accountLabel: "EU 2", delta: -20 },
      { toonHandle: "3-S2-1-3", region: "KR", accountLabel: "KR 3", delta: 30 },
      { toonHandle: "5-S2-1-4", region: "CN", accountLabel: "CN 4", delta: 40 },
    ].map((journey) => ({ ...journey, start: 5000, end: 5010, peak: 5020 }));

    expect(formatMmrStory(journeys)).toBe(
      "MMR: NA 1 +10 · EU 2 -20 · +2 more accounts.",
    );
  });
});
