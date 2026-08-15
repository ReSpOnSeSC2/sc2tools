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
 * Complete response-owned taxonomy. The component must render these categories,
 * thresholds, scores, and counts without keeping a second client-side registry.
 */
function trait(
  key: string,
  label: string,
  noun: string,
  adjective: string,
  blurb: string,
  thresholdText: string,
  extras: Record<string, number> = {},
) {
  return { key, label, noun, adjective, blurb, thresholdText, ...extras };
}

const TAXONOMY = {
  axes: [
    {
      key: "repertoire",
      label: "Build variety",
      description:
        "Shannon effective diversity weights every recognized build by how often you actually use it.",
      leftLabel: "Build-Order One-Trick",
      centerLabel: "Consistent Grinder",
      rightLabel: "Creative Genius",
      categories: [
        trait(
          "one_trick",
          "Build-Order One-Trick",
          "Purist",
          "Devoted",
          "A deeply rehearsed primary plan.",
          "1.5 or fewer effective builds",
        ),
        trait(
          "signature",
          "Signature Pilot",
          "Pilot",
          "Signature",
          "A small signature pool with a real alternate plan.",
          "more than 1.5, up to 2.5 effective builds",
        ),
        trait(
          "grinder",
          "Consistent Grinder",
          "Grinder",
          "Disciplined",
          "A dependable core sharpened through regular use.",
          "more than 2.5, up to 5 effective builds",
        ),
        trait(
          "adaptive",
          "Adaptive Strategist",
          "Strategist",
          "Adaptive",
          "A broad working repertoire.",
          "more than 5, fewer than 10 effective builds",
        ),
        trait(
          "creative",
          "Creative Genius",
          "Inventor",
          "Creative",
          "Variety is a defining weapon.",
          "10 or more effective builds",
        ),
      ],
    },
    {
      key: "pace",
      label: "Game length",
      description:
        "Whether your games end early, in the mid game, or late — and whether you do both.",
      leftLabel: "Cheeser",
      centerLabel: "Flexible Pacer",
      rightLabel: "Late-Game Master",
      categories: [
        trait(
          "cheeser",
          "Cheeser",
          "Ambusher",
          "All-In",
          "At least 80% of your games end before 5:00, or the remaining fallback profile still averages under 5:00.",
          "80%+ under 5:00, or average under 5:00 fallback",
        ),
        trait(
          "timing_attacker",
          "Timing Attacker",
          "Striker",
          "Clockwork",
          "Your games cluster in a concentrated timing window.",
          "80%+ of games from 5:00 through 10:00",
        ),
        trait(
          "flexible",
          "Flexible Pacer",
          "Operator",
          "Flexible",
          "No stronger timing signature dominates.",
          "average from 5:00 through 10:00",
        ),
        trait(
          "mid_late_master",
          "Mid/Late-Game Master",
          "Navigator",
          "Transitional",
          "Your games repeatedly reach the mid game and later.",
          "80%+ of games over 10:00",
        ),
        trait(
          "late_game",
          "Long-Game Lean",
          "Endurer",
          "Long-Game",
          "Your average runs beyond ten minutes.",
          "average over 10:00",
        ),
        trait(
          "late_game_master",
          "Late-Game Master",
          "Commander",
          "Endgame",
          "Deep late-game play is repeatable.",
          "80%+ of games over 15:00",
        ),
        trait(
          "two_speed",
          "Two-Speed Player",
          "Switchblade",
          "Two-Speed",
          "You expose two distinct tempo gears.",
          "25%+ under 5:00 and 25%+ over 15:00",
        ),
      ],
    },
    {
      key: "matchup_edge",
      label: "Matchup edge",
      description:
        "Your win rate in this matchup minus the average of your other two, in percentage points.",
      leftLabel: "Matchup Specialist",
      centerLabel: "Matchup Universalist",
      rightLabel: "Matchup Blind Spot",
      categories: [
        trait(
          "specialist",
          "Matchup Specialist",
          "Ace",
          "Dominant",
          "This selected matchup is a defining strength.",
          "10+ points better",
          { score: 2, trackPosition: 0 },
        ),
        trait(
          "matchup_edge",
          "Matchup Edge",
          "Hunter",
          "Favored",
          "This selected matchup is on the strength side.",
          "up to 10 points better",
          { score: 1, trackPosition: 25 },
        ),
        trait(
          "universalist",
          "Matchup Universalist",
          "Universalist",
          "Even-Handed",
          "All three matchup rates stay close.",
          "all 3 within 5 points",
          { score: 0, trackPosition: 50 },
        ),
        trait(
          "matchup_hurdle",
          "Matchup Hurdle",
          "Climber",
          "Battle-Tested",
          "This selected matchup is on the weakness side.",
          "up to 10 points worse",
          { score: -1, trackPosition: 75 },
        ),
        trait(
          "blind_spot",
          "Matchup Blind Spot",
          "Underdog",
          "Fault-Line",
          "This selected matchup is a defining weakness.",
          "10+ points worse",
          { score: -2, trackPosition: 100 },
        ),
      ],
    },
  ],
};

const MATCHUP_RATES = [
  {
    matchup: "PvP",
    games: 31,
    decidedGames: 30,
    wins: 18,
    losses: 12,
    ties: 1,
    winRate: 60,
  },
  {
    matchup: "PvT",
    games: 30,
    decidedGames: 30,
    wins: 15,
    losses: 15,
    ties: 0,
    winRate: 50,
  },
  {
    matchup: "PvZ",
    games: 32,
    decidedGames: 31,
    wins: 22,
    losses: 9,
    ties: 1,
    winRate: 70.968,
  },
];

function axis<T extends Record<string, unknown>>(overrides: T) {
  return {
    position: 50 as number | null,
    value: 1 as number | null,
    category: null as string | null,
    categoryLabel: null as string | null,
    sampleSize: 0,
    detail: null as Record<string, unknown> | null,
    reason: null as string | null,
    have: null as number | null,
    needed: null as number | null,
    ...overrides,
  };
}

const REPERTOIRE_SUMMARY = {
  method: "shannon_perplexity",
  formula: "exp(-sum(p_i * ln(p_i)))",
  distinctBuilds: 5,
  effectiveBuilds: 3.913,
  topBuildShare: 0.367,
};

const PACE_SUMMARY = {
  averageSec: 489.46,
  medianSec: 480,
  belowFive: { games: 4, percent: 12.5 },
  fiveToTen: { games: 6, percent: 18.75 },
  aboveTen: { games: 22, percent: 68.75 },
  tenToFifteen: { games: 18, percent: 56.25 },
  aboveFifteen: { games: 4, percent: 12.5 },
};

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
      // Public axis.value is the raw distinct count, not Shannon diversity.
      value: 5,
      category: "grinder",
      categoryLabel: "Consistent Grinder",
      sampleSize: 30,
      detail: REPERTOIRE_SUMMARY,
      distinctiveness: 0.64,
      calibration: {
        method: "two_sided_percentile",
        populationSize: 1284,
        percentile: 0.82,
        distinctiveness: 0.64,
      },
    }),
    axis({
      key: "pace",
      label: "Game length",
      position: 32,
      // Public axis.value remains the average duration in seconds.
      value: 489.46,
      category: "flexible",
      categoryLabel: "Flexible Pacer",
      sampleSize: 32,
      detail: PACE_SUMMARY,
      distinctiveness: 0.18,
      calibration: {
        method: "two_sided_percentile",
        populationSize: 1284,
        percentile: 0.59,
        distinctiveness: 0.18,
      },
    }),
    axis({
      key: "matchup_edge",
      label: "Matchup edge",
      position: 0,
      value: 15.968,
      category: "specialist",
      categoryLabel: "Matchup Specialist",
      sampleSize: 31,
      detail: {
        winRate: 70.968,
        comparatorWinRate: 55,
        comparedAgainst: ["PvP", "PvT"],
        signedEdge: 15.968,
        tierScore: 2,
        allMatchupSpread: 20.968,
      },
      distinctiveness: 0.84,
      calibration: {
        method: "tier_rarity",
        populationSize: 1284,
        tierFrequency: 0.16,
        distinctiveness: 0.84,
      },
    }),
  ],
  playstyle: "Dominant Grinder",
  archetype: {
    key: "grinder|flexible|specialist",
    name: "Dominant Grinder",
    description:
      "A dependable core sharpened through regular use. This selected matchup is a defining strength.",
    complete: true,
    components: [
      {
        axis: "matchup_edge",
        category: "specialist",
        distinctiveness: 0.84,
        role: "core" as const,
      },
      {
        axis: "repertoire",
        category: "grinder",
        distinctiveness: 0.64,
        role: "modifier" as const,
      },
      {
        axis: "pace",
        category: "flexible",
        distinctiveness: 0.18,
        role: "supporting" as const,
      },
    ],
  },
  taxonomy: TAXONOMY,
  populationCalibration: {
    status: "ready" as const,
    method: "player_population" as const,
    matchup: "PvZ",
    populationSize: 1284,
    updatedAt: "2026-08-14T12:00:00.000Z",
    version: 1,
  },
  buildOrders: [
    { name: "PvZ - Stargate into Glaives", games: 11 },
    { name: "PvZ - Gate Expand", games: 8 },
    { name: "PvZ - 2 Stargate Void Ray", games: 5 },
    { name: "PvZ - Immortal Sentry", games: 4 },
    { name: "PvZ - DT Drop", games: 2 },
  ],
  repertoireSummary: REPERTOIRE_SUMMARY,
  paceSummary: PACE_SUMMARY,
  matchupWinRates: MATCHUP_RATES,
  matchupSummary: {
    spread: 20.968,
    leaderGap: 10.968,
    weakGap: 10,
    selectedMatchup: "PvZ",
    selectedWinRate: 70.968,
    comparatorWinRate: 55,
    comparedAgainst: ["PvP", "PvT"],
    signedEdge: 15.968,
    tierScore: 2 as const,
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
      expect(url).not.toContain("preset=");
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
      filtersValue = {
        preset: "last_7d",
        since: "2026-08-07T00:00:00.000Z",
      };
      render(<FingerprintCard />);
      expect(useApiMock.mock.calls[0][0]).not.toBe(first);
    });

    it("names the filters the API deliberately ignored", () => {
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

    it("renders the response archetype, three spectra, and replay evidence", () => {
      useApiMock.mockReturnValue(ok());
      render(<FingerprintCard />);

      expect(
        screen.getByRole("heading", { name: "Dominant Grinder" }),
      ).toBeTruthy();
      expect(screen.getByText("Complete profile")).toBeTruthy();
      expect(
        screen.getByTestId("fingerprint-name-rationale").textContent,
      ).toMatch(/Matchup Specialist and Consistent Grinder/);
      expect(
        screen.getByText(/32 recent PvZ 1v1 replays, using up to your latest 50/),
      ).toBeTruthy();
      expect(screen.getByText("3 of 3 tracks ready")).toBeTruthy();

      for (const key of ["repertoire", "pace", "matchup_edge"]) {
        expect(screen.getByTestId("fingerprint-axis-" + key)).toBeTruthy();
        expect(
          screen
            .getByTestId("fingerprint-marker-" + key)
            .getAttribute("style"),
        ).toContain("left:");
      }
      expect(
        screen
          .getByTestId("fingerprint-marker-matchup_edge")
          .getAttribute("style"),
      ).toContain("0%");

      const repertoire = screen.getByTestId("fingerprint-axis-repertoire");
      expect(repertoire.textContent).toMatch(/5 detected/);
      expect(repertoire.textContent).toMatch(/5 distinct builds/);
      expect(repertoire.textContent).toMatch(
        /Shannon diversity.*3\.91 equally used builds/,
      );

      const pace = screen.getByTestId("fingerprint-axis-pace");
      expect(pace.textContent).toMatch(/8:09\.46 avg/);
      expect(pace.textContent).toMatch(/real time-band counts/);

      expect(screen.getByText("PvZ - Stargate into Glaives")).toBeTruthy();
      expect(screen.getByText("8:00 median")).toBeTruthy();
      expect(screen.getByText("5 distinct")).toBeTruthy();
      expect(screen.getAllByText("3.91 effective").length).toBeGreaterThan(0);
    });

    it("describes the selected matchup against the comparison matchups", () => {
      useApiMock.mockReturnValue(ok());
      render(<FingerprintCard />);

      const row = screen.getByTestId("fingerprint-axis-matchup_edge");
      expect(row.textContent).toMatch(/PvP and PvT/);
      // Display precision is one decimal; the API still returns 70.968.
      expect(row.textContent).toMatch(/71%/);
      expect(row.textContent).toMatch(/55%/);
      expect(row.textContent).toMatch(/\+16 pts/);
      expect(row.textContent).toMatch(/score \+2/i);
    });

    it("treats API win rates as percentages, including an exact 1%", () => {
      const onePercent = {
        ...FP,
        axes: FP.axes.map((entry) =>
          entry.key === "matchup_edge"
            ? {
                ...entry,
                detail: {
                  ...entry.detail,
                  winRate: 1,
                },
              }
            : entry,
        ),
        matchupWinRates: FP.matchupWinRates.map((row) =>
          row.matchup === "PvT" ? { ...row, winRate: 1 } : row,
        ),
      };
      useApiMock.mockReturnValue(ok(onePercent));
      render(<FingerprintCard />);

      expect(screen.getByText("1%")).toBeTruthy();
      expect(
        screen.getByTestId("fingerprint-axis-matchup_edge").textContent,
      ).toMatch(/at 1%/);
      expect(screen.queryByText("100%")).toBeNull();
    });

    it("explains distinct and Shannon-effective builds from response values", () => {
      const dynamicSummary = {
        method: "shannon_perplexity",
        formula: "exp(-sum(p_i * ln(p_i)))",
        distinctBuilds: 6,
        effectiveBuilds: 2.718281,
        topBuildShare: 0.5,
      };
      const dynamic = {
        ...FP,
        axes: FP.axes.map((entry) =>
          entry.key === "repertoire"
            ? {
                ...entry,
                value: 6,
                detail: dynamicSummary,
              }
            : entry,
        ),
        buildOrders: [
          { name: "Plan Alpha", games: 15 },
          { name: "Plan Beta", games: 6 },
          { name: "Plan Gamma", games: 3 },
          { name: "Plan Delta", games: 2 },
          { name: "Plan Epsilon", games: 2 },
          { name: "Plan Zeta", games: 2 },
        ],
        repertoireSummary: dynamicSummary,
      };
      useApiMock.mockReturnValue(ok(dynamic));
      const { container } = render(<FingerprintCard />);

      const repertoire = screen.getByTestId("fingerprint-axis-repertoire");
      expect(repertoire.textContent).toMatch(/6 detected/);
      expect(repertoire.textContent).toMatch(/6 distinct builds/);
      expect(repertoire.textContent).toMatch(/2\.72 equally used builds/);
      expect(screen.getByText("6 distinct")).toBeTruthy();
      expect(screen.getAllByText("2.72 effective").length).toBeGreaterThan(0);

      const methodology = screen
        .getByText("How this fingerprint is calculated")
        .closest("details");
      expect(methodology).toBeTruthy();
      const guide = methodology!.textContent ?? "";
      expect(guide).toContain("exp(-sum(p_i * ln(p_i)))");
      expect(guide).toContain(
        "6 detected builds become 2.72 effective builds",
      );
      expect(guide).toContain(
        "as diverse as 2.72 builds used equally often",
      );
      expect(container.textContent).not.toMatch(/14 detected builds/);
      expect(container.textContent).not.toMatch(/8\.35 effective/);
    });

    it("keeps enough effective-build precision near a tier boundary", () => {
      const boundarySummary = {
        ...REPERTOIRE_SUMMARY,
        distinctBuilds: 2,
        effectiveBuilds: 1.503759,
      };
      const boundary = {
        ...FP,
        axes: FP.axes.map((entry) =>
          entry.key === "repertoire"
            ? {
                ...entry,
                position: 1,
                value: 2,
                category: "signature",
                categoryLabel: "Signature Pilot",
                detail: boundarySummary,
              }
            : entry,
        ),
        repertoireSummary: boundarySummary,
      };
      useApiMock.mockReturnValue(ok(boundary));
      render(<FingerprintCard />);

      const repertoire = screen.getByTestId("fingerprint-axis-repertoire");
      expect(repertoire.textContent).toMatch(/2 detected/);
      expect(repertoire.textContent).toMatch(/Signature Pilot/);
      expect(screen.getAllByText("1.503759 effective").length).toBeGreaterThan(0);
    });

    it("renders a Two-Speed profile from returned time buckets", () => {
      const twoSpeedSummary = {
        averageSec: 600,
        medianSec: 540,
        belowFive: { games: 8, percent: 25 },
        fiveToTen: { games: 6, percent: 18.75 },
        aboveTen: { games: 18, percent: 56.25 },
        tenToFifteen: { games: 10, percent: 31.25 },
        aboveFifteen: { games: 8, percent: 25 },
      };
      const twoSpeed = {
        ...FP,
        axes: FP.axes.map((entry) =>
          entry.key === "pace"
            ? {
                ...entry,
                position: 50,
                value: 600,
                category: "two_speed",
                categoryLabel: "Two-Speed Player",
                detail: twoSpeedSummary,
              }
            : entry,
        ),
        paceSummary: twoSpeedSummary,
      };
      useApiMock.mockReturnValue(ok(twoSpeed));
      render(<FingerprintCard />);

      const pace = screen.getByTestId("fingerprint-axis-pace");
      expect(pace.textContent).toMatch(/Two-Speed Player/);
      expect(pace.textContent).toMatch(/10:00 avg/);
      expect(
        screen.getByText(/8\/32 \(25%\) ended under 5:00/),
      ).toBeTruthy();
      expect(
        screen.getByText(/8\/32 \(25%\) ran over 15:00/),
      ).toBeTruthy();
    });

    it("explains a dominant under-five Cheeser despite a long outlier", () => {
      const dominantCheeserSummary = {
        averageSec: 341,
        medianSec: 280,
        belowFive: { games: 19, percent: 95 },
        fiveToTen: { games: 0, percent: 0 },
        aboveTen: { games: 1, percent: 5 },
        tenToFifteen: { games: 0, percent: 0 },
        aboveFifteen: { games: 1, percent: 5 },
      };
      const dominantCheeser = {
        ...FP,
        games: 20,
        axes: FP.axes.map((entry) =>
          entry.key === "pace"
            ? {
                ...entry,
                position: 6.833,
                value: 341,
                category: "cheeser",
                categoryLabel: "Cheeser",
                sampleSize: 20,
                detail: {
                  ...dominantCheeserSummary,
                  classificationMethod: "dominant_under_five",
                },
              }
            : entry,
        ),
        paceSummary: dominantCheeserSummary,
      };
      useApiMock.mockReturnValue(ok(dominantCheeser));
      render(<FingerprintCard />);

      const pace = screen.getByTestId("fingerprint-axis-pace");
      expect(pace.textContent).toMatch(/Cheeser/);
      expect(pace.textContent).toMatch(/5:41 avg/);
      expect(
        screen.getByText(
          /19\/20 \(95%\) ended under 5:00, meeting the 80% rule for Cheeser/,
        ),
      ).toBeTruthy();
    });

    it("reports the date-scoped window rather than a fixed recent-game claim", () => {
      useApiMock.mockReturnValue(
        ok({
          ...FP,
          windowMode: "range",
          windowGames: 500,
          games: 128,
        }),
      );
      filtersValue = {
        preset: "last_90d",
        since: "2026-05-01T00:00:00.000Z",
      };
      render(<FingerprintCard />);

      expect(screen.getByText(/128 PvZ 1v1 replays in/)).toBeTruthy();
    });
  });

  describe("matchup scoring states", () => {
    it.each([
      ["specialist", "Matchup Specialist", 0, 10, 2, "+2"],
      ["matchup_edge", "Matchup Edge", 25, 7.5, 1, "+1"],
      ["universalist", "Matchup Universalist", 50, 1, 0, "0"],
      ["matchup_hurdle", "Matchup Hurdle", 75, -7.5, -1, "-1"],
      ["blind_spot", "Matchup Blind Spot", 100, -10, -2, "-2"],
    ])(
      "renders %s with its response score and track position",
      (category, label, position, delta, score, scoreText) => {
        const variant = {
          ...FP,
          axes: FP.axes.map((entry) =>
            entry.key === "matchup_edge"
              ? {
                  ...entry,
                  position,
                  value: delta,
                  category,
                  categoryLabel: label,
                  detail: {
                    ...entry.detail,
                    signedEdge: delta,
                    tierScore: score,
                    allMatchupSpread: category === "universalist" ? 5 : 20,
                  },
                }
              : entry,
          ),
          matchupSummary: {
            ...FP.matchupSummary,
            spread: category === "universalist" ? 5 : 20,
            signedEdge: delta,
            tierScore: score,
          },
        };
        useApiMock.mockReturnValue(ok(variant));
        render(<FingerprintCard />);

        const row = screen.getByTestId("fingerprint-axis-matchup_edge");
        expect(row.textContent).toContain(label);
        expect(row.textContent?.toLowerCase()).toContain(
          "score " + scoreText.toLowerCase(),
        );
        expect(
          screen
            .getByTestId("fingerprint-marker-matchup_edge")
            .getAttribute("style"),
        ).toContain("left: " + position + "%");
      },
    );
  });

  describe("unrated tracks and honest nulls", () => {
    it("uses the missing-data reason and progress supplied by the API", () => {
      const partial = {
        ...FP,
        status: "partial" as const,
        archetype: { ...FP.archetype, complete: false },
        axes: FP.axes.map((entry) =>
          entry.key === "repertoire"
            ? {
                ...entry,
                position: null,
                value: 2,
                category: null,
                categoryLabel: null,
                reason: "needs_more_classified_builds",
                have: 4,
                needed: 10,
              }
            : entry,
        ),
      };
      useApiMock.mockReturnValue(ok(partial));
      render(<FingerprintCard />);

      const row = screen.getByTestId("fingerprint-axis-repertoire");
      expect(row.textContent).toMatch(/recognized build — 4 of 10/);
      expect(screen.queryByTestId("fingerprint-marker-repertoire")).toBeNull();
      expect(screen.getAllByText("2 of 3 tracks ready")).toHaveLength(2);
    });

    it("explains a missing comparison matchup in its own words", () => {
      const noComparator = {
        ...FP,
        status: "partial" as const,
        archetype: { ...FP.archetype, complete: false },
        axes: FP.axes.map((entry) =>
          entry.key === "matchup_edge"
            ? {
                ...entry,
                position: null,
                value: null,
                category: null,
                categoryLabel: null,
                reason: "no_comparison_matchup",
                have: 20,
                needed: 8,
              }
            : entry,
        ),
      };
      useApiMock.mockReturnValue(ok(noComparator));
      render(<FingerprintCard />);

      expect(
        screen.getByTestId("fingerprint-axis-matchup_edge").textContent,
      ).toMatch(/neither has enough decided games/);
      expect(screen.queryByTestId("fingerprint-marker-matchup_edge")).toBeNull();
    });

    it("does not turn unavailable signals or percentages into zeroes", () => {
      const emptyPace = {
        averageSec: null,
        medianSec: null,
        belowFive: { games: 0, percent: null },
        fiveToTen: { games: 0, percent: null },
        aboveTen: { games: 0, percent: null },
        tenToFifteen: { games: 0, percent: null },
        aboveFifteen: { games: 0, percent: null },
      };
      const forming = {
        ...FP,
        status: "insufficient" as const,
        archetype: {
          key: "partial:?|?|?",
          name: "Profile Still Forming",
          description: "More replay evidence is needed.",
          complete: false,
          components: [],
        },
        axes: FP.axes.map((entry) => ({
          ...entry,
          position: null,
          value: entry.key === "repertoire" ? 0 : null,
          category: null,
          categoryLabel: null,
          sampleSize: 0,
          reason:
            entry.key === "repertoire"
              ? "needs_more_classified_builds"
              : entry.key === "pace"
                ? "needs_more_timed_games"
                : "needs_more_decided_games",
          have: 0,
          needed: entry.key === "matchup_edge" ? 8 : 10,
          detail:
            entry.key === "repertoire"
              ? {
                  ...REPERTOIRE_SUMMARY,
                  distinctBuilds: 0,
                  effectiveBuilds: 0,
                  topBuildShare: null,
                }
              : entry.key === "pace"
                ? emptyPace
                : null,
        })),
        buildOrders: [],
        repertoireSummary: {
          ...REPERTOIRE_SUMMARY,
          distinctBuilds: 0,
          effectiveBuilds: 0,
          topBuildShare: null,
        },
        paceSummary: emptyPace,
        matchupWinRates: [],
        matchupSummary: {
          spread: null,
          leaderGap: null,
          weakGap: null,
          selectedMatchup: "PvZ",
          selectedWinRate: null,
          comparatorWinRate: null,
          comparedAgainst: [],
          signedEdge: null,
          tierScore: null,
          strongestMatchup: null,
          weakestMatchup: null,
        },
      };
      useApiMock.mockReturnValue(ok(forming));
      render(<FingerprintCard />);

      const hero = screen
        .getByRole("heading", { name: "Profile Still Forming" })
        .closest("section");
      expect(hero).toBeTruthy();
      for (const label of [
        "Detected builds",
        "Effective pool",
        "Avg game",
        "Time profile",
        "Matchup edge",
      ]) {
        const stat = within(hero!).getByText(label).closest("div");
        expect(stat).toBeTruthy();
        expect(within(stat!).getByText("Still forming")).toBeTruthy();
      }

      const distribution = screen
        .getByRole("heading", { name: "Game-time distribution" })
        .closest("section");
      expect(distribution).toBeTruthy();
      expect(within(distribution!).getAllByText("—")).toHaveLength(4);
      expect(
        within(distribution!).getByText(/0 valid timed replays are available/),
      ).toBeTruthy();

      const performance = screen
        .getByRole("heading", { name: "Matchup performance" })
        .closest("section");
      expect(performance).toBeTruthy();
      expect(within(performance!).queryByText(/Tier score 0/)).toBeNull();
      expect(within(performance!).queryByText(/0 pts vs comparison/)).toBeNull();
      expect(
        within(performance!).getByText(
          /Matchup win rates will appear when qualifying games are available/,
        ),
      ).toBeTruthy();
    });
  });

  describe("empty and recovery states", () => {
    it("names the range and offers an escape when nothing matched", () => {
      useApiMock.mockReturnValue({
        data: undefined,
        isLoading: false,
        error: { status: 404 },
      });
      filtersValue = {
        preset: "last_7d",
        since: "2026-08-07T00:00:00.000Z",
      };
      render(<FingerprintCard />);

      expect(screen.getByText(/No PvZ games in this range/)).toBeTruthy();
      fireEvent.click(screen.getByTestId("fingerprint-use-all-time"));
      expect(setFiltersMock).toHaveBeenCalledWith(
        expect.objectContaining({
          preset: "all",
          since: undefined,
          until: undefined,
        }),
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
      filtersValue = {
        preset: "last_7d",
        since: "2026-08-07T00:00:00.000Z",
      };
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

  describe("response-owned taxonomy and explanation", () => {
    it("renders all five build tiers, seven timing heuristics, and five matchup scores", () => {
      useApiMock.mockReturnValue(ok());
      render(<FingerprintCard />);

      const repertoire = screen.getByTestId("fingerprint-axis-repertoire");
      for (const category of TAXONOMY.axes[0].categories) {
        expect(
          within(repertoire).getAllByText(category.label).length,
        ).toBeGreaterThan(0);
        expect(
          within(repertoire).getByText(category.thresholdText),
        ).toBeTruthy();
      }

      const pace = screen.getByTestId("fingerprint-axis-pace");
      for (const category of TAXONOMY.axes[1].categories) {
        expect(within(pace).getAllByText(category.label).length).toBeGreaterThan(
          0,
        );
        expect(within(pace).getByText(category.thresholdText)).toBeTruthy();
      }

      const matchup = screen.getByTestId("fingerprint-axis-matchup_edge");
      for (const category of TAXONOMY.axes[2].categories) {
        expect(
          within(matchup).getAllByText(category.label).length,
        ).toBeGreaterThan(0);
        expect(
          within(matchup).getByText(category.thresholdText),
        ).toBeTruthy();
      }
      for (const score of ["Score +2", "Score +1", "Score 0", "Score -1", "Score -2"]) {
        expect(within(matchup).getByText(score)).toBeTruthy();
      }
    });

    it("documents Shannon, timing precedence, and the 5/7.5/10 matchup model", () => {
      useApiMock.mockReturnValue(ok());
      render(<FingerprintCard />);

      const summary = screen.getByText("How this fingerprint is calculated");
      const details = summary.closest("details");
      expect(details).toBeTruthy();
      expect(details!.open).toBe(false);
      fireEvent.click(summary);
      expect(details!.open).toBe(true);

      const guide = details!.textContent ?? "";
      expect(guide).toContain("Shannon diversity");
      expect(guide).toContain("exp(-sum(p_i * ln(p_i)))");
      expect(guide).toContain(
        "5 detected builds become 3.91 effective builds",
      );
      expect(guide).toContain(
        "as diverse as 3.91 builds used equally often",
      );
      expect(guide).toContain("five server tiers");
      expect(guide).toContain("short/long split");
      expect(guide).toContain("80% over-15:00 cluster");
      expect(guide).toContain("80% under-5:00 cluster");
      expect(guide).toContain("80% over-10:00 cluster");
      expect(guide).toContain("80% 5:00–10:00 timing window");
      expect(guide).toContain("under-5:00, 5:00–10:00, and over-10:00");
      expect(guide).toContain("best-to-worst spread is within 5 points");
      expect(guide).toContain("Ahead by 10 points or more is Specialist (score +2)");
      expect(guide).toContain("behind by 10 or more is Blind Spot (score −2)");
      expect(guide).toContain("score used to choose the archetype name");
      expect(guide).toContain("one recent fingerprint per player in PvZ");
      expect(guide).toContain("distance from the population median");
      expect(guide).toContain("how rare their tier is");
      expect(guide).toContain(
        "current reference contains 1,284 qualifying player profiles",
      );
      expect(guide).toContain("±7.5 marks are visual anchors");
      expect(guide).toContain(
        "Ties are displayed but do not enter win rates",
      );
      expect(guide).toContain("175 possible three-trait profiles");
    });

    it("explains the conservative naming behavior while calibration is unavailable", () => {
      useApiMock.mockReturnValue(
        ok({
          ...FP,
          populationCalibration: {
            status: "unavailable",
            method: "player_population",
          },
        }),
      );
      render(<FingerprintCard />);

      const methodology = screen
        .getByText("How this fingerprint is calculated")
        .closest("details");
      expect(methodology).toBeTruthy();
      const guide = methodology!.textContent ?? "";
      expect(guide).toContain("Population calibration is still building");
      expect(guide).toContain(
        "no marker position is treated as distinctive by itself",
      );
      expect(guide).not.toContain("1,284 qualifying player profiles");
    });

    it("shows 17 response traits while reporting the 5×7×5 product", () => {
      useApiMock.mockReturnValue(ok());
      render(<FingerprintCard />);

      const catalog = screen.getByTestId("fingerprint-archetype-catalog");
      expect(within(catalog).getByText("175 possible profiles")).toBeTruthy();
      expect(
        within(catalog).getAllByTestId("archetype-option"),
      ).toHaveLength(17);
      const current = within(catalog)
        .getAllByTestId("archetype-option")
        .filter((element) => element.getAttribute("aria-current") === "true");
      expect(current).toHaveLength(3);
      expect(within(catalog).getAllByText(/Your trait/)).toHaveLength(3);
    });

    it("computes the profile count from a compact response taxonomy", () => {
      const compact = {
        ...FP,
        taxonomy: {
          axes: [
            {
              ...TAXONOMY.axes[0],
              categories: TAXONOMY.axes[0].categories.slice(0, 2),
            },
            {
              ...TAXONOMY.axes[1],
              categories: TAXONOMY.axes[1].categories.slice(0, 3),
            },
            {
              ...TAXONOMY.axes[2],
              categories: TAXONOMY.axes[2].categories.slice(0, 4),
            },
          ],
        },
      };
      useApiMock.mockReturnValue(ok(compact));
      render(<FingerprintCard />);

      const catalog = screen.getByTestId("fingerprint-archetype-catalog");
      expect(within(catalog).getByText("24 possible profiles")).toBeTruthy();
      expect(
        within(catalog).getAllByTestId("archetype-option"),
      ).toHaveLength(9);
      const methodology = screen
        .getByText("How this fingerprint is calculated")
        .closest("details");
      expect(methodology?.textContent).toContain(
        "24 possible three-trait profiles",
      );
    });

    it("renders invented response vocabulary and the response archetype verbatim", () => {
      const inventedCategory = trait(
        "grinder",
        "Invented Trait",
        "Nounish",
        "Adjectival",
        "Invented blurb.",
        "some threshold",
      );
      const invented = {
        ...FP,
        playstyle: "Fallback Name",
        archetype: {
          ...FP.archetype,
          name: "Server-Named Maverick",
          description: "A description supplied only by this response.",
        },
        taxonomy: {
          axes: [
            {
              ...TAXONOMY.axes[0],
              label: "Invented Track",
              description: "Invented description.",
              leftLabel: "Left",
              centerLabel: "Centre",
              rightLabel: "Right",
              categories: [inventedCategory],
            },
            TAXONOMY.axes[1],
            TAXONOMY.axes[2],
          ],
        },
      };
      useApiMock.mockReturnValue(ok(invented));
      render(<FingerprintCard />);

      expect(
        screen.getByRole("heading", { name: "Server-Named Maverick" }),
      ).toBeTruthy();
      expect(
        screen.getByText("A description supplied only by this response."),
      ).toBeTruthy();

      const catalog = screen.getByTestId("fingerprint-archetype-catalog");
      const heading = within(catalog).getByText("Invented Track");
      const group = heading.closest("li");
      expect(group).toBeTruthy();
      expect(within(group!).getByText("Invented Trait")).toBeTruthy();
      expect(within(group!).getByText("Adjectival · Nounish")).toBeTruthy();
      expect(within(group!).getByText("Invented blurb.")).toBeTruthy();
      expect(within(group!).getByText("some threshold")).toBeTruthy();
      expect(
        within(group!).getByTestId("archetype-option").getAttribute(
          "aria-current",
        ),
      ).toBe("true");
      expect(
        within(group!).queryByText("Build-Order One-Trick"),
      ).toBeNull();
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
