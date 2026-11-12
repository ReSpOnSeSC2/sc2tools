// @ts-nocheck
"use strict";

const { spawnSync } = require("node:child_process");
const { join } = require("node:path");
const { summarizeBalance } = require("../src/services/pulseBalanceSummary");
const fixture = require("./fixtures/pulseBalance.synthetic.json");

const diamond = fixture.tiers[1];
const snapshotWithRows = (...rows) => ({ ...fixture, tiers: [{ ...diamond, rows }] });

describe("ladder balance summary", () => {
  test("pools counts across end-minute buckets including the unnumbered bucket", () => {
    const { tiers } = summarizeBalance(fixture);
    expect(tiers[0].matchups[0]).toMatchObject({
      matchup: "PvT",
      sameTier: { games: 100, wins: 60, winRate: 0.6, interval: { low: 0.502, high: 0.6906 } },
      crossTier: { games: 50, wins: 3, winRate: 0.06 },
    });
  });

  test("retains all three non-mirror matchups and distinguishes empty cohorts from losses", () => {
    const loss = { matchup: "PvZ", crossTier: false, games: 8, wins: 0 };
    const { tiers } = summarizeBalance(snapshotWithRows(loss));
    const matchups = tiers[0].matchups;
    expect(matchups.map(({ matchup }) => matchup)).toEqual(["PvT", "PvZ", "TvZ"]);
    expect(matchups[1].sameTier).toEqual({
      games: 8, wins: 0, winRate: 0, interval: { low: 0, high: 0.3244 },
    });
    expect(matchups[1].crossTier).toEqual({ games: 0, wins: 0, winRate: null, interval: null });
  });

  test("orders tiers and preserves their distinct samples and date", () => {
    const grandmaster = { league: "grandmaster", division: null, rows: [] };
    const diamondThird = { ...diamond, division: 3 };
    const input = { ...fixture, tiers: [diamondThird, ...fixture.tiers, grandmaster] };
    const { season, asOf, tiers } = summarizeBalance(input);
    expect({ season, asOf }).toEqual({ season: 1, asOf: "2026-01-02" });
    expect(tiers.map(({ league, division }) => [league, division])).toEqual([
      ["grandmaster", null], ["diamond", 1], ["diamond", 3], ["gold", 2],
    ]);
    expect(tiers[3].matchups[0].sameTier).toMatchObject({ games: 7, wins: 2, winRate: 0.2857 });
  });

  test("returns an empty tier set for an empty snapshot", () => {
    expect(summarizeBalance({ ...fixture, tiers: [] }).tiers).toEqual([]);
  });
});

describe("ladder balance input validation", () => {
  test.each([
    [null, /snapshot must be an object/],
    [{ ...fixture, season: 0 }, /season must be positive/],
    [{ ...fixture, season: "1" }, /season must be a nonnegative safe integer/],
    [{ ...fixture, asOf: "2026-02-30" }, /valid calendar day/],
    [{ ...fixture, asOf: "2026-01-02T00:00:00.000Z" }, /UTC calendar day/],
    [{ ...fixture, tiers: {} }, /tiers must be an array/],
    [{ ...fixture, tiers: [diamond, diamond] }, /Duplicate league tier/],
    [{ ...fixture, tiers: [{ ...diamond, league: "unranked" }] }, /Unknown league/],
    [{ ...fixture, tiers: [{ ...diamond, league: "grandmaster" }] }, /needs division/],
    [{ ...fixture, tiers: [{ ...diamond, rows: null }] }, /rows must be an array/],
  ])("rejects a malformed snapshot or tier %#", (input, message) => {
    expect(() => summarizeBalance(input)).toThrow(message);
  });

  const row = diamond.rows[0];
  test.each([
    [null, /row must be an object/],
    [{ ...row, matchup: "TvP" }, /canonical non-mirror matchup/],
    [{ ...row, matchup: "PvP" }, /canonical non-mirror matchup/],
    [{ ...row, crossTier: "false" }, /crossTier must be a boolean/],
    [{ ...row, wins: 21 }, /wins cannot exceed games/],
    [{ ...row, games: 20.5 }, /games must be a nonnegative safe integer/],
    [{ ...row, wins: -1 }, /wins must be a nonnegative safe integer/],
  ])("rejects a malformed count row %#", (input, message) => {
    expect(() => summarizeBalance(snapshotWithRows(input))).toThrow(message);
  });

  test("rejects pooled counts beyond safe integer precision", () => {
    const large = { ...row, games: Number.MAX_SAFE_INTEGER };
    expect(() => summarizeBalance(snapshotWithRows(large, row))).toThrow(/pooled games/);
  });
});

describe("local ladder balance preview", () => {
  const script = join(__dirname, "../scripts/preview-ladder-balance.js");
  const input = join(__dirname, "fixtures/pulseBalance.synthetic.json");

  test("prints the synthetic preview as JSON without leaking source dimensions", () => {
    const { status, stdout, stderr } = spawnSync(process.execPath, [script, input], { encoding: "utf8" });
    expect({ status, stderr }).toEqual({ status: 0, stderr: "" });
    expect(JSON.parse(stdout)).toEqual(summarizeBalance(fixture));
    expect(stdout).not.toContain("endMinute");
  });

  test("fails clearly when no input file is specified", () => {
    const { status, stdout, stderr } = spawnSync(process.execPath, [script], { encoding: "utf8" });
    expect({ status, stdout }).toEqual({ status: 1, stdout: "" });
    expect(stderr).toContain("Usage:");
  });

  test("rejects malformed JSON without printing its contents", () => {
    const { status, stdout, stderr } = spawnSync(process.execPath, [script, __filename], { encoding: "utf8" });
    expect({ status, stdout, stderr }).toEqual({ status: 1, stdout: "", stderr: "Input is not valid JSON.\n" });
  });
});
