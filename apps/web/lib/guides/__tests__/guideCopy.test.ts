import { describe, expect, test } from "vitest";
import {
  buildCounterIntro,
  buildIntro,
  buildMapIntro,
  buildMatchupIntro,
  buildTimingsBlurb,
  GUIDE_THIN_SAMPLE_GAMES,
  type GuideCopyLine,
} from "@/lib/guides/guideCopy";
import { fmtClock, fmtCount, fmtPct } from "@/lib/guides/format";
import {
  FIXTURE_BUILD_PUBLISHED,
  FIXTURE_BUILD_UNPUBLISHED,
  FIXTURE_COUNTER_PUBLISHED,
  FIXTURE_COUNTER_UNPUBLISHED,
  FIXTURE_MAP,
  FIXTURE_MAP_UNPUBLISHED,
  FIXTURE_MATCHUP,
  FIXTURE_MATCHUP_BAND,
} from "@/lib/guides/__fixtures__";
import type {
  GuideBuildPublished,
  GuideCounterPublished,
  GuideMapPublished,
  GuideMatchupPayload,
} from "@/lib/guides/types";

const PERCENT_SCALE = 100;

function collect(value: unknown, numbers: Set<number>, strings: string[]): void {
  if (typeof value === "number") numbers.add(value);
  else if (typeof value === "string") strings.push(value);
  else if (Array.isArray(value)) value.forEach((entry) => collect(entry, numbers, strings));
  else if (value && typeof value === "object") {
    Object.values(value).forEach((entry) => collect(entry, numbers, strings));
  }
}

/** Every way a payload number may legitimately appear in copy. */
function renderedForms(n: number): string[] {
  return [
    fmtCount(n),
    fmtPct(n).replace("%", ""),
    (Math.abs(n) * PERCENT_SCALE).toFixed(1),
    fmtClock(n),
    String(n),
  ];
}

/** Digit runs left after removing payload strings (names, labels, patch). */
function numericTokens(text: string, strings: string[]): string[] {
  let scrubbed = text;
  const withDigits = strings.filter((s) => /\d/.test(s)).sort((a, b) => b.length - a.length);
  for (const s of withDigits) scrubbed = scrubbed.split(s).join(" ");
  return scrubbed.match(/\d[\d,.:]*\d|\d/g) ?? [];
}

/**
 * Traceability: every digit run in every sentence is a formatting of a
 * number the line declares, every declared number renders, and every
 * declared number exists in the payload.
 */
function expectTraceable(lines: GuideCopyLine[], payload: unknown): void {
  const numbers = new Set<number>();
  const strings: string[] = [];
  collect(payload, numbers, strings);
  for (const entry of lines) {
    const tokens = numericTokens(entry.text, strings);
    const allowed = new Set(entry.numbers.flatMap(renderedForms));
    for (const token of tokens) {
      expect(allowed.has(token), `"${token}" in ${entry.id}: ${entry.text}`).toBe(true);
    }
    for (const n of entry.numbers) {
      expect(numbers.has(n), `${n} (${entry.id}) is not a payload number`).toBe(true);
      const forms = renderedForms(n);
      expect(tokens.some((t) => forms.includes(t)), `${n} not rendered in ${entry.id}`).toBe(true);
    }
  }
}

function ids(lines: GuideCopyLine[]): string[] {
  return lines.map((entry) => entry.id);
}

const THIN_GAMES = 142;

function thinBuild(): GuideBuildPublished {
  return {
    ...FIXTURE_BUILD_PUBLISHED,
    overall: { ...FIXTURE_BUILD_PUBLISHED.overall, games: THIN_GAMES },
  };
}

describe("buildIntro", () => {
  test("published: overview, range, headline, prevalence, trend — all traceable", () => {
    const lines = buildIntro(FIXTURE_BUILD_PUBLISHED);
    expect(ids(lines)).toEqual([
      "intro-overview",
      "intro-range",
      "intro-headline",
      "intro-prevalence",
      "intro-trend",
    ]);
    expectTraceable(lines, FIXTURE_BUILD_PUBLISHED);
    expect(lines[0].text).toContain("412");
    expect(lines[0].text).toContain("53.9%");
    expect(lines[1].text).toContain("too close to call");
    expect(lines[2].text).toBe("It is played most against Diamond opponents, where it wins 56.5% over 146 games.");
    expect(lines[4].text).toBe(
      "Its win rate is up 1.3 percentage points on the previous weekly snapshot.",
    );
  });

  test("thin sample adds a plain directional caveat", () => {
    const payload = thinBuild();
    expect(THIN_GAMES).toBeLessThan(GUIDE_THIN_SAMPLE_GAMES);
    const lines = buildIntro(payload);
    const thin = lines.find((entry) => entry.id === "intro-thin");
    expect(thin).toEqual({
      id: "intro-thin",
      text: "This is still a small sample (n = 142), so treat it as a directional read.",
      numbers: [THIN_GAMES],
    });
    expectTraceable(lines, payload);
  });

  test("new guides say so instead of a trend; flat trends are silent", () => {
    const fresh = buildIntro({ ...FIXTURE_BUILD_PUBLISHED, isNew: true, trend: null });
    expect(ids(fresh)).toContain("intro-new");
    expect(ids(fresh)).not.toContain("intro-trend");
    const flat = buildIntro({
      ...FIXTURE_BUILD_PUBLISHED,
      trend: { winRateDelta: 0.002, prevalenceDelta: 0, since: "2026-09-19T03:10:02.000Z" },
    });
    expect(ids(flat)).not.toContain("intro-trend");
  });

  test("missing optional inputs skip their sentences", () => {
    const lines = buildIntro({
      ...FIXTURE_BUILD_PUBLISHED,
      prevalence: null,
      matchupGames: null,
      headline: { scope: "all", value: null, label: null, games: 412, winRate: 0.539 },
      trend: null,
    });
    expect(ids(lines)).toEqual(["intro-overview", "intro-range"]);
  });

  test("clear verdicts follow the interval, not the point estimate", () => {
    const winning = buildIntro({
      ...FIXTURE_BUILD_PUBLISHED,
      overall: { ...FIXTURE_BUILD_PUBLISHED.overall, ci: { low: 0.5102, high: 0.5988 } },
    });
    expect(winning[1].text).toContain("wins more often than it loses");
    const losing = buildIntro({
      ...FIXTURE_BUILD_PUBLISHED,
      overall: { ...FIXTURE_BUILD_PUBLISHED.overall, ci: { low: 0.3811, high: 0.4702 } },
    });
    expect(losing[1].text).toContain("loses more often than it wins");
  });

  test("unpublished and missing payloads render nothing", () => {
    expect(buildIntro(FIXTURE_BUILD_UNPUBLISHED)).toEqual([]);
    expect(buildIntro(null)).toEqual([]);
    expect(buildIntro(undefined)).toEqual([]);
  });

  test("deterministic per slug, varied across slugs", () => {
    expect(buildIntro(FIXTURE_BUILD_PUBLISHED)).toEqual(buildIntro(FIXTURE_BUILD_PUBLISHED));
    const slugs = ["a", "b", "c", "d", "e", "f", "g", "h"];
    const openings = new Set(
      slugs.map((slug) => buildIntro({ ...FIXTURE_BUILD_PUBLISHED, buildSlug: slug })[0].text),
    );
    expect(openings.size).toBeGreaterThan(1);
  });
});

describe("buildTimingsBlurb", () => {
  test("sample, payoff and winners-vs-losers lines, all traceable", () => {
    const lines = buildTimingsBlurb(FIXTURE_BUILD_PUBLISHED);
    expect(ids(lines)).toEqual(["timings-sample", "timings-payoff", "timings-split"]);
    expect(lines[1].text).toBe(
      "The median player finishes Resonating Glaives at 7:21, with the middle half between 7:10 and 7:38.",
    );
    expect(lines[2].text).toBe(
      "Winning games start Twilight Council at 4:44 on median, against 4:57 in losses.",
    );
    expectTraceable(lines, FIXTURE_BUILD_PUBLISHED);
  });

  test("thin timing samples add a caveat; no split data skips that line", () => {
    const base = FIXTURE_BUILD_PUBLISHED;
    const timings = base.timings!;
    const payload: GuideBuildPublished = {
      ...base,
      timings: {
        ...timings,
        samples: 120,
        milestones: timings.milestones.map(({ winners: _w, losers: _l, ...rest }) => rest),
      },
    };
    const lines = buildTimingsBlurb(payload);
    expect(ids(lines)).toEqual(["timings-sample", "timings-payoff", "timings-thin"]);
    expectTraceable(lines, payload);
  });

  test("no timings / unpublished → []", () => {
    expect(buildTimingsBlurb({ ...FIXTURE_BUILD_PUBLISHED, timings: null })).toEqual([]);
    expect(
      buildTimingsBlurb({
        ...FIXTURE_BUILD_PUBLISHED,
        timings: { samples: 300, users: 40, milestones: [] },
      }),
    ).toEqual([]);
    expect(buildTimingsBlurb(FIXTURE_BUILD_UNPUBLISHED)).toEqual([]);
  });
});

describe("buildCounterIntro", () => {
  test("overview, best and runner-up answers, traceable", () => {
    const lines = buildCounterIntro(FIXTURE_COUNTER_PUBLISHED);
    expect(ids(lines)).toEqual(["counter-overview", "counter-best", "counter-runner-up"]);
    expect(lines[0].text).toContain("Protoss players");
    expect(lines[1].text).toContain(FIXTURE_COUNTER_PUBLISHED.openers[0].name);
    expectTraceable(lines, FIXTURE_COUNTER_PUBLISHED);
  });

  test("no openers and a thin sample", () => {
    const payload: GuideCounterPublished = {
      ...FIXTURE_COUNTER_PUBLISHED,
      overall: { ...FIXTURE_COUNTER_PUBLISHED.overall, games: THIN_GAMES },
      openers: [],
    };
    const lines = buildCounterIntro(payload);
    expect(ids(lines)).toEqual(["counter-overview", "counter-thin"]);
    expectTraceable(lines, payload);
  });

  test("unpublished → []", () => {
    expect(buildCounterIntro(FIXTURE_COUNTER_UNPUBLISHED)).toEqual([]);
    expect(buildCounterIntro(null)).toEqual([]);
  });
});

describe("buildMatchupIntro", () => {
  test("overview, top published opener and most common pick", () => {
    const lines = buildMatchupIntro(FIXTURE_MATCHUP);
    expect(ids(lines)).toEqual(["matchup-overview", "matchup-top", "matchup-popular"]);
    expect(lines[1].text).toContain("Adept Glaives (Robo)");
    expect(lines[2].text).toContain("Standard Blink Macro");
    expectTraceable(lines, FIXTURE_MATCHUP);
  });

  test("band view names the band and skips null prevalence", () => {
    const lines = buildMatchupIntro(FIXTURE_MATCHUP_BAND);
    expect(ids(lines)).toEqual(["matchup-overview", "matchup-band", "matchup-top"]);
    expect(lines[1].text).toContain("Diamond");
    expectTraceable(lines, FIXTURE_MATCHUP_BAND);
  });

  test("an MMR band reads as a rating range", () => {
    const payload: GuideMatchupPayload = {
      ...FIXTURE_MATCHUP_BAND,
      band: { type: "mmr", value: 4500, label: "4500–5000" },
    };
    const band = buildMatchupIntro(payload).find((entry) => entry.id === "matchup-band");
    expect(band?.text).toContain("Filtered to opponents rated 4500–5000 MMR;");
    expect(band?.numbers).toEqual([]);
  });

  test("unpublished or totals missing → []; thin totals add a caveat", () => {
    expect(buildMatchupIntro({ ...FIXTURE_MATCHUP, published: false })).toEqual([]);
    expect(buildMatchupIntro({ ...FIXTURE_MATCHUP, games: null })).toEqual([]);
    const thin: GuideMatchupPayload = { ...FIXTURE_MATCHUP, games: 180, openers: [] };
    const lines = buildMatchupIntro(thin);
    expect(ids(lines)).toEqual(["matchup-overview", "matchup-thin"]);
    expectTraceable(lines, thin);
  });
});

describe("era wording", () => {
  // Enough seeds that every template variant of each overview is hit.
  const SEEDS = "abcdefghijklmnopqrstuvwxyz".split("");

  /** Every overview variant (seeded by slug) for each page kind. */
  function overviews(
    build: GuideBuildPublished,
    matchup: GuideMatchupPayload,
    map: GuideMapPublished,
  ): string[] {
    return SEEDS.flatMap((seed) => [
      buildIntro({ ...build, buildSlug: seed })[0].text,
      buildMatchupIntro({ ...matchup, slug: seed })[0].text,
      buildMapIntro({ ...map, mapSlug: seed })[0].text,
    ]);
  }

  test("current-era copy says 'since patch', never 'on patch'", () => {
    const texts = overviews(FIXTURE_BUILD_PUBLISHED, FIXTURE_MATCHUP, FIXTURE_MAP);
    // 3 build + 2 matchup + 2 map templates.
    expect(new Set(texts).size).toBe(7);
    for (const text of texts) {
      expect(text).toMatch(/since patch 5\.0\.16/i);
      expect(text).not.toMatch(/on patch|before patch/i);
    }
  });

  test("pre-patch payloads say 'before patch' (the numbers are not from 5.0.16)", () => {
    const build: GuideBuildPublished = { ...FIXTURE_BUILD_PUBLISHED, era: "before" };
    const matchup: GuideMatchupPayload = { ...FIXTURE_MATCHUP, era: "before" };
    const map: GuideMapPublished = { ...FIXTURE_MAP, era: "before" };
    const texts = overviews(build, matchup, map);
    for (const text of texts) {
      expect(text).toMatch(/before patch 5\.0\.16/i);
      expect(text).not.toMatch(/since patch|on patch/i);
    }
    expectTraceable(buildIntro(build), build);
    expectTraceable(buildMatchupIntro(matchup), matchup);
  });
});

describe("buildMapIntro", () => {
  test("overview, busiest matchup with win rate, standout opener", () => {
    const lines = buildMapIntro(FIXTURE_MAP);
    expect(ids(lines)).toEqual(["map-overview", "map-busiest", "map-standout"]);
    expect(lines[1].text).toContain("PvZ is the most played matchup here with 512 games");
    expect(lines[1].text).toContain("Protoss wins");
    expectTraceable(lines, FIXTURE_MAP);
  });

  test("a mirror busiest matchup states no win rate", () => {
    const mirror: GuideMapPublished = {
      ...FIXTURE_MAP,
      matchups: FIXTURE_MAP.matchups.filter((row) => row.matchup === "PvP"),
    };
    const lines = buildMapIntro(mirror);
    expect(lines.find((entry) => entry.id === "map-busiest")?.text).toBe(
      "PvP is the most played matchup here with 208 games.",
    );
    expect(ids(lines)).not.toContain("map-standout");
    expectTraceable(lines, mirror);
  });

  test("unpublished → []", () => {
    expect(buildMapIntro(FIXTURE_MAP_UNPUBLISHED)).toEqual([]);
    expect(buildMapIntro(undefined)).toEqual([]);
  });
});

describe("one-player guides", () => {
  const onePlayer = (text: string) => {
    expect(text).toContain("1 player");
    expect(text).not.toMatch(/\b1 players\b/);
    expect(text).not.toMatch(/\b1 player have\b/);
  };

  test("build, timings, counter and matchup copy say 1 player", () => {
    const build: GuideBuildPublished = {
      ...FIXTURE_BUILD_PUBLISHED,
      overall: { ...FIXTURE_BUILD_PUBLISHED.overall, users: 1 },
      timings: { ...FIXTURE_BUILD_PUBLISHED.timings!, users: 1 },
    };
    onePlayer(buildIntro(build)[0].text);
    onePlayer(buildTimingsBlurb(build)[0].text);

    const counter: GuideCounterPublished = {
      ...FIXTURE_COUNTER_PUBLISHED,
      overall: { ...FIXTURE_COUNTER_PUBLISHED.overall, users: 1 },
    };
    onePlayer(buildCounterIntro(counter)[0].text);

    for (const slug of ["pvz", "pvt", "pvp", "zvp", "tvz"]) {
      const matchup: GuideMatchupPayload = { ...FIXTURE_MATCHUP, slug, users: 1 };
      onePlayer(buildMatchupIntro(matchup)[0].text);
    }
  });
});
