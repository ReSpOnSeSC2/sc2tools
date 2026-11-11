import { describe, expect, it } from "vitest";
import { buildInstantReport } from "../report";
import { CSV_BOM, CSV_COLUMNS, csvCell, gamesToCsv, reportSummaryText } from "../reportExport";
import { realWin } from "./fixtures/reportGames";

const NOW = new Date("2026-09-27T12:00:00Z");

describe("instant report export", () => {
  it("writes a BOM and RFC 4180 cells without treating opponent names as spreadsheet formulas", () => {
    const base = realWin();
    const report = buildInstantReport([{ ...base, map: 'A,"B"\nC',
      opponent: { ...base.opponent!, displayName: "=1+1", mmr: null } }], NOW);
    const csv = gamesToCsv(report.games);
    expect(csv.startsWith(CSV_BOM + CSV_COLUMNS.join(",") + "\r\n")).toBe(true);
    expect(csv).toContain('"A,""B""\nC"');
    expect(csv).toContain(",'=1+1,Zerg,5326,,470,7:50,");
    for (const value of ["=SUM(1,2)", "+1", "-1", "@today", " =1"]) {
      expect(csvCell(value)).toMatch(/^"?'/);
    }
    expect(csv.endsWith("\r\n")).toBe(true);
  });

  it("summarizes the active filters without opponent names or individual games", () => {
    const report = buildInstantReport([realWin()], NOW);
    const summary = reportSummaryText(report, { matchup: "Z", result: "all", recency: "25" });
    expect(summary).toContain("SC2 Tools /try report: 1 game, 1-0 (100%)");
    expect(summary).toContain("Filtered: vs Z · last 25 games");
    expect(summary).toContain("PvZ - Adept Glaives (Robo)");
    expect(summary).not.toMatch(/Squirtuoz|Tourmaline|5079063/);
  });
});
