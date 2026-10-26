import { describe, expect, it } from "vitest";
import { shapeBucketComparisons } from "../MmrBucketChart";
import { shapeAgingForChart } from "../BuildAgingCurve";
import { shapeProgressionForChart } from "../MmrProgressionByBuild";

const palette = Array.from({ length: 8 }, (_, index) => `series-${index}`);
const point = (n: number, cumulativeWins: number, cumulativeLosses: number) => ({ n, cumulativeWins, cumulativeLosses, wins: 1, losses: 0 });

describe("MMR chart display projections retain their metric definitions", () => {
  it("keeps tagged-game rates and minimum eligibility separate from the decided cue", () => {
    const { bands } = shapeBucketComparisons([
      { series: "Opening", bucket: 4000, label: "4000–4199", games: 5, wins: 1, losses: 1 },
      { series: "Sparse", bucket: 4000, label: "4000–4199", games: 2, wins: 2, losses: 0 },
      { series: "Unknown results", bucket: 4000, label: "4000–4199", games: 4, wins: 0, losses: 0 },
    ], 3);
    expect(bands[0].rows.find(row => row.series === "Opening")).toMatchObject({ rate: 0.2, games: 5, decided: 2, belowMinimum: false });
    expect(bands[0].rows.find(row => row.series === "Sparse")).toMatchObject({ rate: null, games: 2, decided: 2, belowMinimum: true });
    expect(bands[0].rows.find(row => row.series === "Unknown results")).toMatchObject({ rate: 0, decided: 0 });
    expect(bands[0].rows[0].sampleSize).toBeUndefined();
  });
  it("keeps ascending bands, volume order and the prior last supplied cell", () => {
    const result = shapeBucketComparisons([
      { series: "Opening", bucket: 4400, label: "4400–4599", games: 3, wins: 1, losses: 2 },
      { series: "Other", bucket: 4000, label: "4000–4199", games: 4, wins: 2, losses: 2 },
      { series: "Opening", bucket: 4400, label: "4400–4599", games: 5, wins: 4, losses: 1 },
    ], 3);
    expect(result.totalGames).toBe(12);
    expect(result.bands.map(row => row.bucket)).toEqual([4000, 4400]);
    expect(result.bands[1].rows[0]).toMatchObject({ series: "Opening", games: 5, rate: 0.8 });
    expect(result.bands[0].rows[0]).toMatchObject({ series: "Opening", games: 0, rate: null });
  });
  it("retains cumulative decided denominators and play-count qualification", () => {
    const result = shapeAgingForChart([
      { build: "Opening", curve: [point(100, 1, 0), point(200, 1, 1), point(300, 1, 1)] },
      { build: "Below minimum", curve: [point(1, 1, 0), point(2, 2, 0)] },
    ], 3, 6, palette);
    expect(result.totalPoints).toBe(3);
    expect(result.seriesList.map(row => row.name)).toEqual(["Opening"]);
    expect(result.chartData.map(row => [row.n, row.Opening, row.Opening__decided])).toEqual([[1, 100, 1], [2, 50, 2], [3, 50, 2]]);
  });
  it("retains local-day last-point projection, volume limit and padded MMR domain", () => {
    const result = shapeProgressionForChart([
      { build: "Opening", points: [
        { date: "2026-10-25T00:00:00Z", mmr: 4000, result: "win" },
        { date: "2026-10-25T04:00:00Z", mmr: 4050, result: "win" },
        { date: "2026-10-25T08:00:00Z", mmr: 4100, result: "loss" },
      ] },
      { build: "Other", points: [{ date: "2026-10-25T08:00:00Z", mmr: 3000, result: "win" }] },
    ], 1, 1, "America/Los_Angeles", palette);
    expect(result.totalPoints).toBe(3);
    expect(result.chartData.map(row => [row.dateKey, row.Opening, row.Opening__decided])).toEqual([["2026-10-24", 4050, 2], ["2026-10-25", 4100, 3]]);
    expect(result.mmrDomain).toEqual([3950, 4150]);
    expect(result.seriesList.map(row => row.name)).toEqual(["Opening"]);
  });
  it("forwards distinct dash cues beyond the eight themed colors", () => {
    const result = shapeAgingForChart(Array.from({ length: 9 }, (_, index) => ({ build: `Build ${index}`, curve: [point(1, 1, 0)] })), 1, 20, palette);
    expect(new Set(result.seriesList.map(row => row.color)).size).toBe(8);
    expect(result.seriesList.some(row => row.strokeDasharray)).toBe(true);
  });
  it("keeps empty input empty without inventing rates or a rating scale", () => {
    expect(shapeBucketComparisons([], 3)).toEqual({ bands: [], totalGames: 0 });
    expect(shapeAgingForChart([], 3, 6, palette).totalPoints).toBe(0);
    expect(shapeProgressionForChart([], 3, 6, "UTC", palette)).toMatchObject({ chartData: [], totalPoints: 0, mmrDomain: ["dataMin", "dataMax"] });
  });
});
