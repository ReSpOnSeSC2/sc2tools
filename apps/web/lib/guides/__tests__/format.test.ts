import { describe, expect, test } from "vitest";
import {
  fmtCi,
  fmtClock,
  fmtCount,
  fmtCountNoun,
  fmtDeltaPp,
  fmtGuideDate,
  fmtPct,
  fmtPresence,
  GUIDE_MISSING,
  GUIDE_TREND_FLAT_THRESHOLD,
  guideBandLabel,
  guideBandQueryString,
  guideLeagueLabel,
  guideMmrLabel,
  parseGuideBand,
  parseGuideEra,
  serializeGuideBand,
  trendDirection,
} from "@/lib/guides/format";

describe("guide number formatting", () => {
  test("fmtPct keeps one decimal", () => {
    expect(fmtPct(0.539)).toBe("53.9%");
    expect(fmtPct(null)).toBe(GUIDE_MISSING);
  });

  test("fmtCi renders an en-dash range with one decimal", () => {
    expect(fmtCi({ low: 0.5142, high: 0.5701 })).toBe("51.4–57.0%");
    expect(fmtCi(null)).toBe(GUIDE_MISSING);
    expect(fmtCi({ low: Number.NaN, high: 0.5 })).toBe(GUIDE_MISSING);
  });

  test("fmtCount uses deterministic en-US separators", () => {
    expect(fmtCount(1234567)).toBe("1,234,567");
    expect(fmtCount(0)).toBe("0");
    expect(fmtCount(undefined)).toBe(GUIDE_MISSING);
  });

  test("fmtCountNoun agrees the noun with 0, 1 and 2", () => {
    expect(fmtCountNoun(0, "opener")).toBe("0 openers");
    expect(fmtCountNoun(1, "opener")).toBe("1 opener");
    expect(fmtCountNoun(2, "opener")).toBe("2 openers");
    expect(fmtCountNoun(1, "match", "matches")).toBe("1 match");
    expect(fmtCountNoun(1234, "ladder game")).toBe("1,234 ladder games");
  });

  test("fmtPresence never rounds a partial share up to 100%", () => {
    expect(fmtPresence(199 / 200)).toBe(">99%");
    expect(fmtPresence(0.9966)).toBe(">99%");
    expect(fmtPresence(0.9999)).toBe(">99%");
    expect(fmtPresence(1)).toBe("100%");
    expect(fmtPresence(0.994)).toBe("99%");
    expect(fmtPresence(0.29)).toBe("29%");
    expect(fmtPresence(null)).toBe(GUIDE_MISSING);
  });

  test("fmtClock rounds before splitting minutes", () => {
    expect(fmtClock(271)).toBe("4:31");
    expect(fmtClock(59.6)).toBe("1:00");
    expect(fmtClock(5)).toBe("0:05");
    expect(fmtClock(-1)).toBe(GUIDE_MISSING);
    expect(fmtClock(null)).toBe(GUIDE_MISSING);
  });

  test("trendDirection treats sub-threshold moves as flat", () => {
    expect(trendDirection(0.0131)).toBe("up");
    expect(trendDirection(-0.0212)).toBe("down");
    expect(trendDirection(GUIDE_TREND_FLAT_THRESHOLD / 2)).toBe("flat");
    expect(trendDirection(-GUIDE_TREND_FLAT_THRESHOLD / 2)).toBe("flat");
    expect(trendDirection(null)).toBe("flat");
    expect(trendDirection(0.02, 0.05)).toBe("flat");
  });

  test("fmtDeltaPp signs with a true minus", () => {
    expect(fmtDeltaPp(0.0123)).toBe("+1.2 pp");
    expect(fmtDeltaPp(-0.008)).toBe("−0.8 pp");
    expect(fmtDeltaPp(0.0001)).toBe("0.0 pp");
    expect(fmtDeltaPp(undefined)).toBe(GUIDE_MISSING);
  });

  test("fmtGuideDate is a fixed UTC calendar date", () => {
    expect(fmtGuideDate("2026-09-27T23:59:00.000Z")).toBe("Sep 27, 2026");
    expect(fmtGuideDate("not a date")).toBe(GUIDE_MISSING);
    expect(fmtGuideDate(null)).toBe(GUIDE_MISSING);
  });
});

describe("band / era query parsing", () => {
  test("parses league and mmr bands", () => {
    expect(parseGuideBand("league:4")).toEqual({ type: "league", value: 4 });
    expect(parseGuideBand("mmr:4500")).toEqual({ type: "mmr", value: 4500 });
    expect(parseGuideBand(" MMR:1000 ")).toEqual({ type: "mmr", value: 1000 });
    expect(parseGuideBand(["league:6", "league:1"])).toEqual({ type: "league", value: 6 });
  });

  test("rejects unknown axes and values", () => {
    for (const raw of ["league:7", "mmr:4400", "rank:4", "league:", "league:-1", "4", "", null, 4]) {
      expect(parseGuideBand(raw)).toBeNull();
    }
  });

  test("serialize round-trips", () => {
    const band = { type: "mmr" as const, value: 4500 };
    expect(serializeGuideBand(band)).toBe("mmr:4500");
    expect(parseGuideBand(serializeGuideBand(band))).toEqual(band);
  });

  test("era defaults to the current patch", () => {
    expect(parseGuideEra("before")).toBe("before");
    expect(parseGuideEra(["before"])).toBe("before");
    expect(parseGuideEra("after")).toBe("after");
    expect(parseGuideEra("bogus")).toBe("after");
    expect(parseGuideEra(undefined)).toBe("after");
  });

  test("query string omits defaults so the canonical URL has none", () => {
    expect(guideBandQueryString(null)).toBe("");
    expect(guideBandQueryString(null, "after")).toBe("");
    expect(guideBandQueryString(null, "before")).toBe("?era=before");
    expect(guideBandQueryString({ type: "league", value: 4 }, "before")).toBe(
      "?band=league:4&era=before",
    );
  });

  test("band labels reuse the Ladder Pulse tables", () => {
    expect(guideLeagueLabel(4)).toBe("Diamond");
    expect(guideLeagueLabel(9)).toBeNull();
    expect(guideMmrLabel(4500)).toBe("4500–5000 MMR");
    expect(guideMmrLabel(6500)).toBe("6500+ MMR");
    expect(guideMmrLabel(4400)).toBeNull();
    expect(guideBandLabel({ type: "league", value: 6 })).toBe("Grandmaster");
    expect(guideBandLabel({ type: "mmr", value: 1000 })).toBe("<2000 MMR");
  });
});
