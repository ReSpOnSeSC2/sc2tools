import { describe, expect, it } from "vitest";
import {
  MATCHUPS,
  MMR_BANDS,
  bandLabel,
  isValidMatchup,
  metaHref,
  parseAxis,
  parseBand,
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

describe("opponent band helpers", () => {
  it("publishes the exact 11 opponent-MMR bands", () => {
    expect(MMR_BANDS).toEqual([
      { key: 1000, label: "<2000" },
      { key: 2000, label: "2000–2500" },
      { key: 2500, label: "2500–3000" },
      { key: 3000, label: "3000–3500" },
      { key: 3500, label: "3500–4000" },
      { key: 4000, label: "4000–4500" },
      { key: 4500, label: "4500–5000" },
      { key: 5000, label: "5000–5500" },
      { key: 5500, label: "5500–6000" },
      { key: 6000, label: "6000–6500" },
      { key: 6500, label: "6500+" },
    ]);
  });

  it("parses axes and uses axis-specific defaults", () => {
    expect(parseAxis("MMR")).toBe("mmr");
    expect(parseAxis("league")).toBe("league");
    expect(parseAxis("unknown")).toBe("league");
    expect(parseBand("league", undefined)).toBe(4);
    expect(parseBand("mmr", undefined)).toBe(4000);
  });

  it("only accepts published keys for the selected axis", () => {
    expect(parseBand("league", "6")).toBe(6);
    expect(parseBand("mmr", "1000")).toBe(1000);
    expect(parseBand("mmr", "6500")).toBe(6500);
    expect(parseBand("mmr", "1500")).toBe(4000);
    expect(parseBand("mmr", "4000junk")).toBe(4000);
  });

  it("labels both axes and builds canonical round-trippable URLs", () => {
    expect(bandLabel("league", 5)).toBe("Master");
    expect(bandLabel("mmr", 1000)).toBe("<2000");
    expect(bandLabel("mmr", 4000)).toBe("4000–4500");
    expect(bandLabel("mmr", 6500)).toBe("6500+");

    const href = metaHref("mmr", 4500, "tVz");
    expect(href).toBe("/meta?axis=mmr&band=4500&matchup=TvZ");
    const params = new URL(href, "https://sc2tools.com").searchParams;
    const axis = parseAxis(params.get("axis"));
    expect(axis).toBe("mmr");
    expect(parseBand(axis, params.get("band"))).toBe(4500);
    expect(parseMatchup(params.get("matchup"))).toBe("TvZ");
  });
});
