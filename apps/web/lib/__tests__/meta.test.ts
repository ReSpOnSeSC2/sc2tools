import { describe, expect, it } from "vitest";
import {
  MATCHUPS,
  isValidMatchup,
  parseLeagueId,
  parseMatchup,
} from "../meta";

describe("parseMatchup", () => {
  it("accepts every canonical matchup unchanged", () => {
    // Regression: toUpperCase() used to fold the 'v' into 'V', so
    // isValidMatchup rejected the result and every selection collapsed to
    // the PvZ default — the matchup picker looked frozen. Round-tripping
    // each real option must return that same option.
    for (const m of MATCHUPS) {
      expect(parseMatchup(m)).toBe(m);
    }
  });

  it("canonicalizes case variants to '<X>v<Y>'", () => {
    expect(parseMatchup("pvt")).toBe("PvT");
    expect(parseMatchup("PVT")).toBe("PvT");
    expect(parseMatchup("zVp")).toBe("ZvP");
    expect(parseMatchup("  tvz  ")).toBe("TvZ");
  });

  it("falls back to PvZ for missing or malformed input", () => {
    expect(parseMatchup(undefined)).toBe("PvZ");
    expect(parseMatchup(null)).toBe("PvZ");
    expect(parseMatchup("")).toBe("PvZ");
    expect(parseMatchup("XvY")).toBe("PvZ");
    expect(parseMatchup("PvTv")).toBe("PvZ");
    expect(parseMatchup(42)).toBe("PvZ");
  });

  it("returns a value isValidMatchup accepts", () => {
    for (const raw of ["pvz", "TVT", "zvz", "garbage"]) {
      expect(isValidMatchup(parseMatchup(raw))).toBe(true);
    }
  });
});

describe("parseLeagueId", () => {
  it("passes through valid league ids", () => {
    expect(parseLeagueId("6")).toBe(6);
    expect(parseLeagueId(0)).toBe(0);
  });

  it("defaults to Diamond (4) for out-of-range or bad input", () => {
    expect(parseLeagueId("99")).toBe(4);
    expect(parseLeagueId("nope")).toBe(4);
    expect(parseLeagueId(undefined)).toBe(4);
  });
});
