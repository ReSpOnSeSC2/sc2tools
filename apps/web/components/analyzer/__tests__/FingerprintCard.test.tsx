import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { FingerprintCard } from "../FingerprintCard";

const useApiMock = vi.fn();
vi.mock("@/lib/clientApi", () => ({
  useApi: (...args: unknown[]) => useApiMock(...args),
}));

const setFiltersMock = vi.fn();
let filtersValue: Record<string, unknown> = { preset: "all" };
let dbRevValue = 0;

vi.mock("@/lib/filterContext", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/filterContext")>();
  return {
    ...actual,
    useFilters: () => ({
      filters: filtersValue,
      setFilters: setFiltersMock,
      dbRev: dbRevValue,
      bumpRev: vi.fn(),
      seasons: [],
    }),
  };
});

afterEach(() => {
  cleanup();
  useApiMock.mockReset();
  setFiltersMock.mockReset();
  filtersValue = { preset: "all" };
  dbRevValue = 0;
  window.localStorage.clear();
});

/**
 * A trimmed taxonomy. Labels here are deliberately not the production strings
 * — several tests assert that the card renders whatever the API sends, which
 * is what proves no vocabulary is hardcoded in the component any more.
 */
const TAXONOMY = {
  axes: [
    {
      key: "repertoire",
      label: "Build variety",
      description: "How many builds you lean on.",
      leftLabel: "One-Trick",
      centerLabel: "Adaptive Strategist",
      rightLabel: "Creative Genius",
      categories: [
        {
          key: "one_trick",
          label: "One-Trick",
          noun: "Purist",
          adjective: "One-Track",
          blurb: "One build carries this matchup.",
          thresholdText: "under 1.6 effective builds",
        },
        {
          key: "adaptive",
          label: "Adaptive Strategist",
          noun: "Strategist",
          adjective: "Adaptive",
          blurb: "A working handful of builds.",
          thresholdText: "2.8 to 4.5 effective builds",
        },
      ],
    },
    {
      key: "pace",
      label: "Game length",
      description: "Where your games get decided.",
      leftLabel: "Cheeser",
      centerLabel: "Flexible Pacer",
      rightLabel: "Late-Game Specialist",
      categories: [
        {
          key: "standard",
          label: "Flexible Pacer",
          noun: "Operator",
          adjective: "Measured",
          blurb: "Mid-game games.",
          thresholdText: "most games between 7:00 and 14:00",
        },
        {
          key: "two_speed",
          label: "Two-Speed",
          noun: "Switchblade",
          adjective: "Two-Speed",
          blurb: "You play two different games.",
          thresholdText: "30%+ both under 7:00 and over 14:00",
        },
      ],
    },
    {
      key: "matchup_edge",
      label: "Matchup edge",
      description: "This matchup against your other two.",
      leftLabel: "Matchup Edge",
      centerLabel: "On Par",
      rightLabel: "Matchup Gap",
      categories: [
        {
          key: "edge_strong",
          label: "Matchup Edge",
          noun: "Hunter",
          adjective: "Dominant",
          blurb: "You want to see this matchup.",
          thresholdText: "7.5+ points above your other matchups",
        },
        {
          key: "edge_on_par",
          label: "On Par",
          noun: "All-Rounder",
          adjective: "Even-Handed",
          blurb: "No clear strength here.",
          thresholdText: "within 7.5 points",
        },
      ],
    },
  ],
};

const MATCHUP_RATES = [
  { matchup: "PvP", games: 31, decidedGames: 30, wins: 18, losses: 12, ties: 1, winRate: 60 },
  { matchup: "PvT", games: 30, decidedGames: 30, wins: 15, losses: 15, ties: 0, winRate: 50 },
  { matchup: "PvZ", games: 32, decidedGames: 31, wins: 22, losses: 9, ties: 1, winRate: 70.968 },
];

function axis(overrides: Record<string, unknown> = {}) {
  return {
    position: 50,
    value: 1,
    category: null,
    categoryLabel: null,
    sampleSize: 0,
    detail: null,
    reason: null,
    have: null,
    needed: null,
    ...overrides,
  };
}

const FP = {
  matchup: "PvZ",
  race: "P",
  games: 32,
  windowGames: 50,
  windowMode: "recent" as const,
  windowTruncated: false,
  strippedFilters: [] as string[],
  status: "complete" as const,
  axes: [
    axis({
      key: "repertoire",
      label: "Build variety",
      position: 38,
      value: 5,
      category: "adaptive",
      categoryLabel: "Adaptive Strategist",
      sampleSize: 30,
      detail: { effectiveBuilds: 3.4, distinctBuilds: 5, topBuildShare: 0.37 },
    }),
    axis({
      key: "pace",
      label: "Game length",
      position: 32,
      value: 489.46,
      category: "standard",
      categoryLabel: "Flexible Pacer",
      sampleSize: 32,
      detail: {
        earlyShare: 0.19,
        midShare: 0.68,
        lateShare: 0.13,
        medianSec: 489.46,
        meanSec: 502,
      },
    }),
    axis({
      key: "matchup_edge",
      label: "Matchup edge",
      position: 8,
      value: 15.968,
      category: "edge_strong",
      categoryLabel: "Matchup Edge",
      sampleSize: 31,
      detail: {
        winRate: 70.968,
        comparatorWinRate: 55,
        comparedAgainst: ["PvP", "PvT"],
      },
    }),
  ],
  playstyle: "Dominant Strategist",
  archetype: {
    key: "adaptive|standard|edge_strong",
    name: "Dominant Strategist",
    description: "A working handful of builds. You want to see this matchup.",
    complete: true,
    components: [
      { axis: "matchup_edge", category: "edge_strong", distinctiveness: 0.84, role: "core" as const },
      { axis: "repertoire", category: "adaptive", distinctiveness: 0.24, role: "modifier" as const },
      { axis: "pace", category: "standard", distinctiveness: 0.36, role: "supporting" as const },
    ],
  },
  taxonomy: TAXONOMY,
  buildOrders: [
    { name: "PvZ - Stargate into Glaives", games: 11 },
    { name: "PvZ - Gate Expand", games: 8 },
    { name: "PvZ - 2 Stargate Void Ray", games: 5 },
  ],
  matchupWinRates: MATCHUP_RATES,
  matchupSummary: {
    spread: 20.968,
    leaderGap: 10.968,
    weakGap: 10,
    strongestMatchup: "PvZ",
    weakestMatchup: "PvT",
  },
};

function ok(fingerprint: unknown = FP) {
  return { data: { fingerprint }, isLoading: false, error: undefined };
}

describe("FingerprintCard", () => {
  describe("filter wiring", () => {
    it("sends the global filters and the db revision with the request", () => {
      filtersValue = {
        preset: "last_30d",
        since: "2026-01-01T00:00:00.000Z",
        until: "2026-02-01T00:00:00.000Z",
        map_pool: "ladder",
      };
      dbRevValue = 7;
      useApiMock.mockReturnValue({ data: undefined, isLoading: true });
      render(<FingerprintCard />);

      const [url, options] = useApiMock.mock.calls[0];
      expect(url).toContain("/v1/me/fingerprint?matchup=PvZ");
      expect(url).toContain("since=2026-01-01T00%3A00%3A00.000Z");
      expect(url).toContain("until=2026-02-01T00%3A00%3A00.000Z");
      expect(url).toContain("map_pool=ladder");
      // UI-only key never goes on the wire.
      expect(url).not.toContain("preset=");
      // Revalidates when new replays land, which the card never used to do.
      expect(url).toContain("#7");
      expect(options).toEqual({ revalidateOnFocus: false });
    });

    it("changing the date range changes the request key", () => {
      useApiMock.mockReturnValue({ data: undefined, isLoading: true });
      filtersValue = { preset: "all" };
      const { unmount } = render(<FingerprintCard />);
      const first = useApiMock.mock.calls[0][0];
      unmount();

      useApiMock.mockClear();
      filtersValue = { preset: "last_7d", since: "2026-08-07T00:00:00.000Z" };
      render(<FingerprintCard />);
      expect(useApiMock.mock.calls[0][0]).not.toBe(first);
    });

    it("names the filters it deliberately ignores", () => {
      useApiMock.mockReturnValue(
        ok({ ...FP, strippedFilters: ["build", "mmr_min"] }),
      );
      render(<FingerprintCard />);
      const note = screen.getByTestId("fingerprint-stripped-filters");
      expect(note.textContent).toMatch(/build/);
      expect(note.textContent).toMatch(/MMR/);
    });
  });

  describe("rendering", () => {
    it("shows a skeleton while loading", () => {
      useApiMock.mockReturnValue({ data: undefined, isLoading: true });
      const { container } = render(<FingerprintCard />);
      expect(container.querySelector(".animate-pulse")).toBeTruthy();
    });

    it("renders the archetype, its rationale, and each spectrum", () => {
      useApiMock.mockReturnValue(ok());
      render(<FingerprintCard />);

      expect(screen.getByText("Dominant Strategist")).toBeTruthy();
      expect(
        screen.getByTestId("fingerprint-name-rationale").textContent,
      ).toMatch(/Matchup Edge and Adaptive Strategist/);

      for (const key of ["repertoire", "pace", "matchup_edge"]) {
        const row = screen.getByTestId(`fingerprint-axis-${key}`);
        expect(row).toBeTruthy();
        expect(
          screen.getByTestId(`fingerprint-marker-${key}`).getAttribute("style"),
        ).toContain("left:");
      }
      // Position, not a hardcoded guess.
      expect(
        screen.getByTestId("fingerprint-marker-matchup_edge").getAttribute("style"),
      ).toContain("8%");
    });

    it("describes the matchup edge against the matchups it compared", () => {
      useApiMock.mockReturnValue(ok());
      render(<FingerprintCard />);
      const row = screen.getByTestId("fingerprint-axis-matchup_edge");
      expect(row.textContent).toMatch(/PvP and PvT/);
      expect(row.textContent).toMatch(/70\.968%/);
    });

    it("explains build concentration when it differs from the raw count", () => {
      useApiMock.mockReturnValue(ok());
      render(<FingerprintCard />);
      const row = screen.getByTestId("fingerprint-axis-repertoire");
      expect(row.textContent).toMatch(/5 different builds/);
      expect(row.textContent).toMatch(/3\.4 effective builds/);
    });

    it("renders a share bar so a two-speed player is not read as mid-game", () => {
      const twoSpeed = {
        ...FP,
        axes: FP.axes.map((a) =>
          a.key === "pace"
            ? {
                ...a,
                position: 50,
                category: "two_speed",
                categoryLabel: "Two-Speed",
                detail: {
                  earlyShare: 0.42,
                  midShare: 0.14,
                  lateShare: 0.44,
                  medianSec: 700,
                  meanSec: 720,
                },
              }
            : a,
        ),
      };
      useApiMock.mockReturnValue(ok(twoSpeed));
      render(<FingerprintCard />);
      const shares = screen.getByTestId("fingerprint-pace-shares");
      expect(shares.textContent).toMatch(/Early 42%/);
      expect(shares.textContent).toMatch(/Late 44%/);
    });

    it("reports the date-scoped window rather than a fixed 50-game claim", () => {
      useApiMock.mockReturnValue(
        ok({ ...FP, windowMode: "range", windowGames: 500, games: 128 }),
      );
      filtersValue = { preset: "last_90d", since: "2026-05-01T00:00:00.000Z" };
      render(<FingerprintCard />);
      expect(screen.getByText(/128 PvZ 1v1 replays in/)).toBeTruthy();
    });
  });

  describe("unrated tracks", () => {
    it("uses the reason the API supplied instead of restating a threshold", () => {
      const partial = {
        ...FP,
        status: "partial" as const,
        archetype: { ...FP.archetype, complete: false },
        axes: FP.axes.map((a) =>
          a.key === "repertoire"
            ? {
                ...a,
                position: null,
                value: 2,
                category: null,
                categoryLabel: null,
                reason: "needs_more_classified_builds",
                have: 4,
                needed: 10,
              }
            : a,
        ),
      };
      useApiMock.mockReturnValue(ok(partial));
      render(<FingerprintCard />);
      const row = screen.getByTestId("fingerprint-axis-repertoire");
      expect(row.textContent).toMatch(/recognized build — 4 of 10/);
      expect(screen.queryByTestId("fingerprint-marker-repertoire")).toBeNull();
      // Shown twice by design: once on the hero badge, once above the tracks.
      expect(screen.getAllByText("2 of 3 tracks ready")).toHaveLength(2);
    });

    it("explains a missing comparison matchup in its own words", () => {
      const noComparator = {
        ...FP,
        status: "partial" as const,
        archetype: { ...FP.archetype, complete: false },
        axes: FP.axes.map((a) =>
          a.key === "matchup_edge"
            ? {
                ...a,
                position: null,
                value: null,
                category: null,
                categoryLabel: null,
                reason: "no_comparison_matchup",
                have: 20,
                needed: 8,
              }
            : a,
        ),
      };
      useApiMock.mockReturnValue(ok(noComparator));
      render(<FingerprintCard />);
      expect(
        screen.getByTestId("fingerprint-axis-matchup_edge").textContent,
      ).toMatch(/neither has enough decided games/);
    });
  });

  describe("empty and recovery states", () => {
    it("names the range and offers an escape when nothing matched", () => {
      useApiMock.mockReturnValue({
        data: undefined,
        isLoading: false,
        error: { status: 404 },
      });
      filtersValue = { preset: "last_7d", since: "2026-08-07T00:00:00.000Z" };
      render(<FingerprintCard />);

      expect(screen.getByText(/No PvZ games in this range/)).toBeTruthy();
      fireEvent.click(screen.getByTestId("fingerprint-use-all-time"));
      expect(setFiltersMock).toHaveBeenCalledWith(
        expect.objectContaining({ preset: "all", since: undefined, until: undefined }),
      );
    });

    it("offers no escape hatch when the range is already all time", () => {
      useApiMock.mockReturnValue({
        data: undefined,
        isLoading: false,
        error: { status: 404 },
      });
      filtersValue = { preset: "all" };
      render(<FingerprintCard />);
      expect(screen.queryByTestId("fingerprint-use-all-time")).toBeNull();
    });

    it("offers the escape hatch on an incomplete profile too", () => {
      useApiMock.mockReturnValue(
        ok({
          ...FP,
          status: "partial",
          archetype: { ...FP.archetype, complete: false },
        }),
      );
      filtersValue = { preset: "last_7d", since: "2026-08-07T00:00:00.000Z" };
      render(<FingerprintCard />);
      expect(screen.getByTestId("fingerprint-use-all-time")).toBeTruthy();
    });

    it("shows a generic failure for non-404 errors", () => {
      useApiMock.mockReturnValue({
        data: undefined,
        isLoading: false,
        error: { status: 500 },
      });
      render(<FingerprintCard />);
      expect(screen.getByText(/Couldn't load your fingerprint/)).toBeTruthy();
    });
  });

  describe("taxonomy-driven copy", () => {
    it("renders only vocabulary the API sent, with the user's trait marked", () => {
      // These labels exist nowhere in the component — if they render, nothing
      // about the vocabulary is hardcoded on the client.
      const invented = {
        ...FP,
        taxonomy: {
          axes: [
            {
              key: "repertoire",
              label: "Invented Track",
              description: "Invented description.",
              leftLabel: "Left",
              centerLabel: "Centre",
              rightLabel: "Right",
              categories: [
                {
                  key: "adaptive",
                  label: "Invented Trait",
                  noun: "Nounish",
                  adjective: "Adjectival",
                  blurb: "Blurb.",
                  thresholdText: "some threshold",
                },
              ],
            },
          ],
        },
      };
      useApiMock.mockReturnValue(ok(invented));
      render(<FingerprintCard />);

      const catalog = screen.getByTestId("fingerprint-archetype-catalog");
      expect(within(catalog).getByText("Invented Trait")).toBeTruthy();
      expect(within(catalog).getByText(/Adjectival · Nounish/)).toBeTruthy();
      const current = within(catalog)
        .getAllByTestId("archetype-option")
        .filter((el) => el.getAttribute("aria-current") === "true");
      expect(current).toHaveLength(1);
      expect(screen.getByText("some threshold")).toBeTruthy();
    });

    it("no longer claims dashboard filters are ignored", () => {
      useApiMock.mockReturnValue(ok());
      const { container } = render(<FingerprintCard />);
      expect(container.textContent).not.toMatch(
        /Dashboard filters do not change/,
      );
    });
  });

  it("matchup picker refetches and persists the selection", () => {
    useApiMock.mockReturnValue(ok());
    render(<FingerprintCard />);
    fireEvent.click(screen.getByLabelText("Versus Terran"));
    expect(
      useApiMock.mock.calls.some(([url]) =>
        String(url).includes("matchup=PvT"),
      ),
    ).toBe(true);
    expect(window.localStorage.getItem("analyzer.fingerprint.matchup")).toBe(
      "PvT",
    );
  });
});
