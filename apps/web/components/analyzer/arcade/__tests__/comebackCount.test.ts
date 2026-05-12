import { describe, expect, test } from "vitest";
import {
  analyzeComebacks,
  COMEBACK_ROTATION,
  comebackCount,
  countBucket,
  dayOfYear,
  depthBucket,
  matchupBucket,
  rateBucket,
  recencyBucket,
  variantOrderFor,
  type ComebackVariant,
} from "../modes/quizzes/comebackCount";
import { mulberry32 } from "../ArcadeEngine";
import type { ArcadeDataset, ArcadeGame } from "../types";

const baseDataset: ArcadeDataset = {
  games: [],
  opponents: [],
  builds: [],
  customBuilds: [],
  communityBuilds: [],
  matchups: [],
  maps: [],
  summary: null,
  mapPool: [],
};

const FIVE_HOURS = 5 * 60 * 60 * 1000;

/**
 * Build a session of `pattern` outcomes ("W"/"L") starting at `start`.
 * Games are spaced 5 minutes apart so they stay inside the 4 h
 * session window. The optional `oppRaces` array maps positionally
 * onto games to drive the matchup variant.
 */
function makeSession(
  start: Date,
  pattern: ReadonlyArray<"W" | "L">,
  oppRaces: ReadonlyArray<string | undefined> = [],
): ArcadeGame[] {
  const out: ArcadeGame[] = [];
  for (let i = 0; i < pattern.length; i++) {
    const t = new Date(start.getTime() + i * 5 * 60 * 1000);
    out.push({
      gameId: `g-${start.toISOString()}-${i}`,
      date: t.toISOString(),
      result: pattern[i] === "W" ? "Win" : "Loss",
      oppRace: oppRaces[i],
    });
  }
  return out;
}

/** Glue sessions together with ≥4 h gaps so sessionize splits them. */
function joinSessions(sessions: ArcadeGame[][]): ArcadeGame[] {
  const out: ArcadeGame[] = [];
  let cursor = new Date("2026-01-01T00:00:00Z").getTime();
  for (const s of sessions) {
    const shifted = s.map((g, i) => ({
      ...g,
      gameId: `${g.gameId}-${out.length + i}`,
      date: new Date(cursor + i * 5 * 60 * 1000).toISOString(),
    }));
    out.push(...shifted);
    cursor +=
      shifted.length * 5 * 60 * 1000 + FIVE_HOURS; /* gap after this session */
  }
  return out;
}

/* ──────────── pure bucketers ──────────── */

describe("Comeback Count — bucketers are pure", () => {
  test("countBucket", () => {
    expect(countBucket(0)).toBe("0");
    expect(countBucket(1)).toBe("1-2");
    expect(countBucket(2)).toBe("1-2");
    expect(countBucket(3)).toBe("3-5");
    expect(countBucket(5)).toBe("3-5");
    expect(countBucket(6)).toBe("6+");
    expect(countBucket(99)).toBe("6+");
  });

  test("rateBucket — edges inclusive on the lower side", () => {
    expect(rateBucket(0)).toBe("0–25%");
    expect(rateBucket(0.25)).toBe("0–25%");
    expect(rateBucket(0.26)).toBe("26–50%");
    expect(rateBucket(0.5)).toBe("26–50%");
    expect(rateBucket(0.51)).toBe("51–75%");
    expect(rateBucket(0.75)).toBe("51–75%");
    expect(rateBucket(0.9)).toBe("76–100%");
    expect(rateBucket(1)).toBe("76–100%");
  });

  test("recencyBucket maps days-ago to fixed buckets", () => {
    const now = new Date("2026-05-12T12:00:00Z");
    expect(recencyBucket("2026-05-10T00:00:00Z", now)).toBe("Last 7 days");
    expect(recencyBucket("2026-05-06T00:00:00Z", now)).toBe("Last 7 days");
    expect(recencyBucket("2026-05-04T00:00:00Z", now)).toBe("1–4 weeks ago");
    expect(recencyBucket("2026-04-25T00:00:00Z", now)).toBe("1–4 weeks ago");
    expect(recencyBucket("2026-03-10T00:00:00Z", now)).toBe("1–3 months ago");
    expect(recencyBucket("2025-11-01T00:00:00Z", now)).toBe("3+ months ago");
  });

  test("recencyBucket — future-dated rows snap to Last 7 days (clock skew)", () => {
    const now = new Date("2026-05-12T12:00:00Z");
    expect(recencyBucket("2026-06-01T00:00:00Z", now)).toBe("Last 7 days");
  });

  test("recencyBucket — non-numeric date returns null", () => {
    expect(recencyBucket("not-a-date", new Date())).toBeNull();
  });

  test("depthBucket clamps at 5+ losses", () => {
    expect(depthBucket(2)).toBe("2 losses");
    expect(depthBucket(3)).toBe("3 losses");
    expect(depthBucket(4)).toBe("4 losses");
    expect(depthBucket(5)).toBe("5+ losses");
    expect(depthBucket(9)).toBe("5+ losses");
  });

  test("matchupBucket maps races, defaults unknown to Random", () => {
    expect(matchupBucket("P")).toBe("vs Protoss");
    expect(matchupBucket("T")).toBe("vs Terran");
    expect(matchupBucket("Z")).toBe("vs Zerg");
    expect(matchupBucket("R")).toBe("vs Random");
    expect(matchupBucket(null)).toBe("vs Random");
  });
});

/* ──────────── analyzeComebacks ──────────── */

describe("Comeback Count — analyzeComebacks", () => {
  test("identifies the canonical 0-2 → above-50% comeback", () => {
    const games = joinSessions([
      makeSession(new Date(), ["L", "L", "W", "W", "W"], ["P", "P", "P", "P", "P"]),
    ]);
    const a = analyzeComebacks(games);
    expect(a.sessions.length).toBe(1);
    expect(a.zeroTwoStarts.length).toBe(1);
    expect(a.comebacks.length).toBe(1);
    expect(a.comebacks[0].wins).toBe(3);
    expect(a.comebacks[0].losses).toBe(2);
    expect(a.comebacks[0].initialLosses).toBe(2);
    expect(a.comebacks[0].firstOppRace).toBe("P");
  });

  test("skips sessions shorter than 3 games", () => {
    const games = joinSessions([makeSession(new Date(), ["L", "L"])]);
    expect(analyzeComebacks(games).comebacks.length).toBe(0);
  });

  test("skips sessions that did not open 0-2", () => {
    const games = joinSessions([
      makeSession(new Date(), ["W", "L", "L", "W", "W"]),
    ]);
    expect(analyzeComebacks(games).zeroTwoStarts.length).toBe(0);
  });

  test("0-2 start with exactly 50% finish is NOT a comeback (strictly >50%)", () => {
    const games = joinSessions([makeSession(new Date(), ["L", "L", "W", "W"])]);
    const a = analyzeComebacks(games);
    expect(a.zeroTwoStarts.length).toBe(1);
    expect(a.comebacks.length).toBe(0);
  });

  test("counts leading losses past the first two as initialLosses", () => {
    const games = joinSessions([
      makeSession(new Date(), ["L", "L", "L", "L", "W", "W", "W", "W", "W"]),
    ]);
    const a = analyzeComebacks(games);
    expect(a.comebacks.length).toBe(1);
    expect(a.comebacks[0].initialLosses).toBe(4);
  });
});

/* ──────────── variant selection ──────────── */

describe("Comeback Count — variantOrderFor", () => {
  test("rotation has the five expected variants", () => {
    expect(COMEBACK_ROTATION).toEqual([
      "count",
      "rate",
      "recency",
      "depth",
      "matchup",
    ]);
  });

  test("pins by day-of-year for daily mode", () => {
    // dayOfYear of Jan 1 is 0 → count.
    expect(variantOrderFor({ daySeed: "2026-01-01", rng: () => 0 })[0]).toBe(
      "count",
    );
    // dayOfYear of Jan 2 is 1 → rate.
    expect(variantOrderFor({ daySeed: "2026-01-02", rng: () => 0 })[0]).toBe(
      "rate",
    );
    // Jan 4 → depth (index 3).
    expect(variantOrderFor({ daySeed: "2026-01-04", rng: () => 0 })[0]).toBe(
      "depth",
    );
  });

  test("rolls via rng when daySeed is empty (Quick Play)", () => {
    // rng=0 picks index 0 (count); rng→0.4 picks index 2 (recency).
    expect(variantOrderFor({ daySeed: "", rng: () => 0 })[0]).toBe("count");
    expect(variantOrderFor({ daySeed: "", rng: () => 0.4 })[0]).toBe(
      "recency",
    );
  });

  test("the tail of the rotation contains every variant once", () => {
    const order = variantOrderFor({ daySeed: "2026-03-04", rng: () => 0 });
    const seen = new Set<ComebackVariant>(order);
    expect(seen.size).toBe(COMEBACK_ROTATION.length);
  });
});

/* ──────────── generate / score wiring ──────────── */

describe("Comeback Count — generate", () => {
  test("ok=false on the empty dataset", async () => {
    const out = await comebackCount.generate({
      rng: mulberry32(1),
      daySeed: "2026-05-10",
      tz: "UTC",
      data: baseDataset,
    });
    expect(out.ok).toBe(false);
  });

  test("ok=false when there are fewer than 5 distinct sessions", async () => {
    const games = joinSessions([
      makeSession(new Date(), ["L", "L", "W", "W", "W"]),
      makeSession(new Date(), ["L", "L", "W", "W", "W"]),
      makeSession(new Date(), ["L", "L", "W", "W", "W"]),
      makeSession(new Date(), ["L", "L", "W", "W", "W"]),
    ]);
    const out = await comebackCount.generate({
      rng: mulberry32(1),
      daySeed: "2026-05-10",
      tz: "UTC",
      data: { ...baseDataset, games },
    });
    expect(out.ok).toBe(false);
  });

  test("falls back to the count variant when today's pinned variant has no data", async () => {
    // Five non-comeback sessions (all WL streaks, no 0-2 start). Day-of-
    // year=1 → pinned variant is `rate`, which gates at ≥3 0-2 starts.
    // With zero such starts, the rate gate fails and we fall through to
    // recency/depth/matchup — also gated by ≥1 comeback — and finally
    // land on `count`, whose truth bucket is "0".
    const games = joinSessions([
      makeSession(new Date(), ["W", "W", "W"]),
      makeSession(new Date(), ["W", "W", "W"]),
      makeSession(new Date(), ["W", "W", "W"]),
      makeSession(new Date(), ["W", "W", "W"]),
      makeSession(new Date(), ["W", "W", "W"]),
    ]);
    const out = await comebackCount.generate({
      rng: mulberry32(1),
      daySeed: "2026-01-02", // pins to "rate"
      tz: "UTC",
      data: { ...baseDataset, games },
    });
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(out.question.variant).toBe("count");
    expect(out.question.truth).toBe("0");
  });

  test("produces the depth variant on a day pinned to depth", async () => {
    // Five 0-2 starts that all become comebacks; one is a deep 5-loss
    // open. Day-of-year(2026-01-04) % 5 = 3 → depth.
    const games = joinSessions([
      makeSession(new Date(), ["L", "L", "W", "W", "W"]),
      makeSession(new Date(), ["L", "L", "W", "W", "W"]),
      makeSession(new Date(), ["L", "L", "W", "W", "W"]),
      makeSession(new Date(), ["L", "L", "W", "W", "W"]),
      makeSession(new Date(), ["L", "L", "L", "L", "L", "W", "W", "W", "W", "W", "W"]),
    ]);
    const out = await comebackCount.generate({
      rng: mulberry32(1),
      daySeed: "2026-01-04", // pins to "depth"
      tz: "UTC",
      data: { ...baseDataset, games },
    });
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(out.question.variant).toBe("depth");
    expect(out.question.truth).toBe("5+ losses");
    expect(out.question.depthTally).toBeDefined();
  });

  test("matchup variant identifies the most common first-game opp race", async () => {
    // Five comebacks: 3 vs P, 1 vs T, 1 vs Z (first game opponent race).
    const games = joinSessions([
      makeSession(new Date(), ["L", "L", "W", "W", "W"], ["P", "P", "P", "P", "P"]),
      makeSession(new Date(), ["L", "L", "W", "W", "W"], ["P", "T", "T", "T", "T"]),
      makeSession(new Date(), ["L", "L", "W", "W", "W"], ["P", "Z", "Z", "Z", "Z"]),
      makeSession(new Date(), ["L", "L", "W", "W", "W"], ["T", "T", "T", "T", "T"]),
      makeSession(new Date(), ["L", "L", "W", "W", "W"], ["Z", "Z", "Z", "Z", "Z"]),
    ]);
    const out = await comebackCount.generate({
      rng: mulberry32(1),
      daySeed: "2026-01-05", // pins to "matchup"
      tz: "UTC",
      data: { ...baseDataset, games },
    });
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(out.question.variant).toBe("matchup");
    expect(out.question.truth).toBe("vs Protoss");
    expect(out.question.raceTally).toEqual({
      "vs Protoss": 3,
      "vs Terran": 1,
      "vs Zerg": 1,
      "vs Random": 0,
    });
  });

  test("rate variant computes (comebacks / 0-2-starts) and buckets", async () => {
    // 4 of 4 0-2 starts become comebacks → 100% → "76–100%".
    const games = joinSessions([
      makeSession(new Date(), ["L", "L", "W", "W", "W"]),
      makeSession(new Date(), ["L", "L", "W", "W", "W"]),
      makeSession(new Date(), ["L", "L", "W", "W", "W"]),
      makeSession(new Date(), ["L", "L", "W", "W", "W"]),
      // Padding session so we hit the ≥5 sessions gate.
      makeSession(new Date(), ["W", "W", "W"]),
    ]);
    const out = await comebackCount.generate({
      rng: mulberry32(1),
      daySeed: "2026-01-02", // pins to "rate"
      tz: "UTC",
      data: { ...baseDataset, games },
    });
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(out.question.variant).toBe("rate");
    expect(out.question.truth).toBe("76–100%");
    expect(out.question.zeroTwoStartCount).toBe(4);
  });
});

describe("Comeback Count — score", () => {
  const sampleQ = {
    variant: "count" as const,
    buckets: ["0", "1-2", "3-5", "6+"] as const,
    truth: "1-2",
    truthValue: 2,
    comebacks: [],
    zeroTwoStartCount: 0,
  };

  test("correct answer earns XP, wrong does not", () => {
    expect(comebackCount.score(sampleQ, "1-2").outcome).toBe("correct");
    expect(comebackCount.score(sampleQ, "1-2").xp).toBeGreaterThan(0);
    expect(comebackCount.score(sampleQ, "0").outcome).toBe("wrong");
    expect(comebackCount.score(sampleQ, "0").xp).toBe(0);
  });

  test("each variant awards a positive XP value on correct", () => {
    const variants: ComebackVariant[] = [
      "count",
      "rate",
      "recency",
      "depth",
      "matchup",
    ];
    for (const v of variants) {
      const q = { ...sampleQ, variant: v };
      expect(comebackCount.score(q, "1-2").xp, `xp for ${v}`).toBeGreaterThan(0);
    }
  });
});

describe("Comeback Count — dayOfYear", () => {
  test("January 1 is index 0", () => {
    expect(dayOfYear("2026-01-01")).toBe(0);
  });
  test("February 1 is 31", () => {
    expect(dayOfYear("2026-02-01")).toBe(31);
  });
  test("empty / invalid seed → 0", () => {
    expect(dayOfYear("")).toBe(0);
    expect(dayOfYear("not-a-date")).toBe(0);
  });
});
