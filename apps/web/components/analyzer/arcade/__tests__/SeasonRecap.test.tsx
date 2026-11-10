import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { ToastProvider } from "@/components/ui/Toast";
import {
  formatMmrStory,
  recapCardStory,
  recapShareText,
  renderSeasonRecapPng,
  SeasonRecap,
} from "../SeasonRecap";
import type { ArcadeGame } from "../types";
import { FiltersContext } from "@/lib/filterContext";
import {
  computeSeasonRecap,
  type RecapWindow,
  type SeasonRecapResult,
} from "@/lib/seasonRecap";
import type { LogicalSeason } from "@/lib/useSeasons";

const useArcadeDataMock = vi.fn();
vi.mock("../hooks/useArcadeData", () => ({
  useArcadeData: () => useArcadeDataMock(),
}));
const trackCardSharedMock = vi.fn();
vi.mock("@/lib/analytics/shareEvents", () => ({
  trackCardShared: (...args: unknown[]) => trackCardSharedMock(...args),
}));

afterEach(() => {
  cleanup();
  useArcadeDataMock.mockReset();
  trackCardSharedMock.mockReset();
  // jsdom has no Web Share API; a test adds one and this removes it.
  Reflect.deleteProperty(navigator, "share");
  Reflect.deleteProperty(navigator, "canShare");
  vi.useRealTimers();
  vi.restoreAllMocks();
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

describe("Season Recap share card (public once shared)", () => {
  const SEASON: RecapWindow = {
    since: new Date("2026-01-01T00:00:00Z"),
    label: "Season 67",
    kind: "season",
  };

  /** A season with a named nemesis and a named upset victim. */
  function rivalSeason(): SeasonRecapResult {
    const games: ArcadeGame[] = [
      ...[1, 2, 3].map((day) => ({
        gameId: `loss-${day}`,
        date: `2026-02-0${day}T10:00:00Z`,
        result: "Defeat",
        oppPulseId: "1-S2-1-5550001",
        oppRace: "Zerg",
        opponent: { displayName: "NemesisName#777", mmr: 4991 },
      })),
      {
        gameId: "upset",
        date: "2026-02-10T10:00:00Z",
        result: "Victory",
        myMmr: 4000,
        oppMmr: 4212,
        oppPulseId: "1-S2-1-5550002",
        oppRace: "Terran",
        myBuild: "PvT - Blink Stalkers",
        opponent: { displayName: "UpsetVictim", mmr: 4212 },
      },
    ] as ArcadeGame[];
    return computeSeasonRecap(games, { since: SEASON.since });
  }

  // Names, ids and ratings of the two opponents, and the exact gap.
  const SECRETS = ["NemesisName", "UpsetVictim", "5550001", "5550002", "4212", "4991", "212"];

  it("describes the nemesis by race and the upset by a rounded gap", () => {
    const recap = rivalSeason();
    // The in-app result still knows who they are, and by exactly how much.
    expect(recap.nemesis?.name).toBe("NemesisName#777");
    expect(recap.biggestUpset?.opponentName).toBe("UpsetVictim");
    expect(recap.biggestUpset?.mmrGap).toBe(212);

    expect(recapCardStory(recap)).toEqual([
      "Signature opener: PvT - Blink Stalkers (1 games).",
      "Nemesis: a Zerg opponent (you went 0-3).",
      "Biggest upset: beat a player about 200 MMR above you.",
    ]);
  });

  it("leaves off an upset too small to survive rounding", () => {
    const recap = rivalSeason();
    const nearlyEven = { ...recap, biggestUpset: { ...recap.biggestUpset!, mmrGap: 49 } };
    expect(recapCardStory(nearlyEven).some((line) => line.includes("upset"))).toBe(false);
    const justEnough = { ...recap, biggestUpset: { ...recap.biggestUpset!, mmrGap: 50 } };
    expect(recapCardStory(justEnough)).toContain(
      "Biggest upset: beat a player about 100 MMR above you.",
    );
  });

  it("prints no rating at all when the player's own MMR was never recorded", () => {
    // myMmr 0 means "not recorded". Read as a rating, the upset gap would
    // be the opponent's own rating, and the MMR delta the player's.
    const games = [0, 0, 4000, 4100, 0].map((myMmr, i) => ({
      gameId: `g${i}`,
      date: `2026-02-0${i + 1}T10:00:00Z`,
      result: "Victory",
      myToonHandle: "1-S2-1-267727",
      myMmr,
      oppRace: "Zerg",
      opponent: { displayName: "Champion", mmr: 6913 },
    })) as ArcadeGame[];
    const story = recapCardStory(computeSeasonRecap(games, { since: SEASON.since }));

    expect(story.join("\n")).not.toContain("6913");
    expect(story.join("\n")).not.toMatch(/4[01]00/);
    expect(story).toContain("MMR: NA 267727 +100.");
    // The two recorded games are real upsets (2,913 and 2,813 above).
    expect(story).toContain("Biggest upset: beat a player about 2900 MMR above you.");
  });

  it("falls back to 'an opponent' when the nemesis race was never recorded", () => {
    const recap = rivalSeason();
    const story = recapCardStory({
      ...recap,
      nemesis: recap.nemesis ? { ...recap.nemesis, race: null } : null,
    });
    expect(story).toContain("Nemesis: an opponent (you went 0-3).");
  });

  it("draws no opponent name, id or rating on the image", async () => {
    const drawn: string[] = [];
    const ctxStub = {
      fillStyle: "",
      font: "",
      textBaseline: "",
      fillRect: vi.fn(),
      fillText: (text: string) => {
        drawn.push(String(text));
      },
      measureText: (t: string) => ({ width: String(t).length * 8 }),
      createLinearGradient: () => ({ addColorStop: vi.fn() }),
    };
    vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue(
      ctxStub as unknown as CanvasRenderingContext2D,
    );
    vi.spyOn(HTMLCanvasElement.prototype, "toBlob").mockImplementation(function (
      this: HTMLCanvasElement,
      cb: BlobCallback,
    ) {
      cb(new Blob(["png-bytes"], { type: "image/png" }));
    });

    const blob = await renderSeasonRecapPng(rivalSeason(), SEASON);

    expect(blob).toBeInstanceOf(Blob);
    const image = drawn.join("\n");
    expect(image).toContain("a Zerg opponent");
    for (const secret of SECRETS) expect(image).not.toContain(secret);
  });

  it("posts text with totals only", () => {
    const text = recapShareText(rivalSeason(), SEASON);
    expect(text).toBe(
      "My SC2 Season 67 recap: 4 games, 25% WR.\n\nhttps://sc2tools.com/arcade",
    );
    for (const secret of SECRETS) expect(text).not.toContain(secret);
  });
});

describe("Share recap button", () => {
  /** Stub the canvas and return everything drawn on it. */
  function stubCanvas(): string[] {
    const drawn: string[] = [];
    vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue({
      fillStyle: "",
      font: "",
      textBaseline: "",
      fillRect: vi.fn(),
      fillText: (text: string) => {
        drawn.push(String(text));
      },
      measureText: (t: string) => ({ width: String(t).length * 8 }),
      createLinearGradient: () => ({ addColorStop: vi.fn() }),
    } as unknown as CanvasRenderingContext2D);
    vi.spyOn(HTMLCanvasElement.prototype, "toBlob").mockImplementation(function (
      this: HTMLCanvasElement,
      cb: BlobCallback,
    ) {
      cb(new Blob(["png-bytes"], { type: "image/png" }));
    });
    return drawn;
  }

  function offerShareSheet(share: (data: ShareData) => Promise<void>) {
    Object.defineProperty(navigator, "share", { configurable: true, value: share });
    Object.defineProperty(navigator, "canShare", { configurable: true, value: () => true });
  }

  /** Open the recap on its last slide, where the Share button lives. */
  function openShareSlide() {
    // recentGames names its opponents Foe0..Foe2; Foe1 is the nemesis.
    useArcadeDataMock.mockReturnValue({ data: { games: recentGames(14) }, loading: false });
    renderCard();
    fireEvent.click(screen.getByRole("button", { name: /open my recap/i }));
    fireEvent.click(screen.getByRole("tab", { name: /share your season/i }));
  }

  it("shares a card that names no opponent, counts it and says so", async () => {
    const drawn = stubCanvas();
    const share = vi.fn<(data: ShareData) => Promise<void>>().mockResolvedValue(undefined);
    offerShareSheet(share);
    openShareSlide();

    fireEvent.click(screen.getByRole("button", { name: "Share recap" }));

    expect(await screen.findByText("Recap shared")).toBeTruthy();
    expect(trackCardSharedMock).toHaveBeenCalledTimes(1);
    expect(trackCardSharedMock).toHaveBeenCalledWith({ card: "season_recap", method: "web_share" });

    const sent = share.mock.calls[0][0];
    expect(sent.title).toBe("SC2 Season Recap");
    expect(sent.text).toMatch(/recap: 14 games, 50% WR, -13 MMR on NA 267727\.\n\nhttps:\/\/sc2tools\.com\/arcade$/);
    expect(sent.files?.[0].name).toBe("sc2-season-recap.png");

    const image = drawn.join("\n");
    // Foe1: two wins and three losses across the fourteen games.
    expect(image).toContain("Nemesis: a Zerg opponent (you went 2-3).");
    expect(`${image}\n${sent.text}`).not.toMatch(/Foe\d/);
  });

  it("neither counts nor announces a dismissed share sheet", async () => {
    stubCanvas();
    const share = vi
      .fn<(data: ShareData) => Promise<void>>()
      .mockRejectedValue(new DOMException("Share canceled", "AbortError"));
    offerShareSheet(share);
    openShareSlide();

    fireEvent.click(screen.getByRole("button", { name: "Share recap" }));
    await waitFor(() => expect(share).toHaveBeenCalledTimes(1));
    // The button leaves its busy state once the attempt is over.
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "Share recap" }).hasAttribute("disabled")).toBe(false),
    );

    expect(trackCardSharedMock).not.toHaveBeenCalled();
    expect(screen.queryByText(/Recap (shared|copied|saved)/)).toBeNull();
    expect(screen.queryByText("Share failed")).toBeNull();
  });
});
