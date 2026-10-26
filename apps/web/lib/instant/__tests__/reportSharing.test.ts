import { describe, expect, it, vi } from "vitest";
import { buildInstantReport } from "../report";
import { realWin } from "./fixtures/reportGames";
import { defaultReportSelection, reportCardModel, reportCardText } from "../reportSharing";
import { drawReportCard, reportPng } from "../reportCard";

function report(games = 3) {
  return buildInstantReport(Array.from({ length: games }, (_, index) => ({ ...realWin(), gameId: `unit-${index}` })), new Date("2026-10-01T00:00:00Z"));
}

describe("private report sharing projection", () => {
  it("copies only selected aggregates and fixed catalog opener labels", () => {
    const source = report();
    const model = reportCardModel(source);
    expect(model.opener?.games).toBe(3);
    expect(model.macro?.score).toBe(72);
    expect(model.matchups).toEqual([{ label: "vs Z", wins: 3, losses: 0 }]);
    const text = reportCardText(model), json = JSON.stringify(model);
    for (const privateValue of ["Squirtuoz", "Tourmaline", "267727", "unit-", "toonHandle", "pulseId", "gameId"]) {
      expect(text).not.toContain(privateValue); expect(json).not.toContain(privateValue);
    }
    const hidden = reportCardModel(source, { totals: false, matchups: [], opener: false, macro: false });
    expect(hidden).toEqual({ totals: null, matchups: [], opener: null, macro: null });
    expect(reportCardText(hidden)).not.toContain("3W");
    expect(reportCardText(model)).toContain("utm_medium=share");
  });

  it("requires three observed games and omits unknown macro and injected names", () => {
    expect(reportCardModel(report(2)).opener).toBeNull();
    const source = report();
    source.openers = [{ name: "PrivateOpponentName", games: 5, wins: 5, losses: 0, winrate: 1 }];
    source.macro = { averageScore: null, games: 0, topLeaks: [] };
    const model = reportCardModel(source);
    expect(model.opener).toBeNull(); expect(model.macro).toBeNull();
    expect(defaultReportSelection(model)).toEqual({ totals: true, matchups: ["Z"], opener: false, macro: false });
  });

  it("draws the actual selected fields at1200×630 without any identity field", () => {
    const calls: string[] = [];
    const ctx = { createLinearGradient: () => ({ addColorStop: vi.fn() }), fillRect: vi.fn(),
      fillText: (value: string) => calls.push(value), measureText: (value: string) => ({ width: value.length * 10 }) };
    const canvas = { width: 0, height: 0, getContext: () => ctx } as unknown as HTMLCanvasElement;
    drawReportCard(canvas, reportCardModel(report()));
    expect([canvas.width, canvas.height]).toEqual([1200, 630]);
    expect(calls).toContain("sc2tools.com/try — analyze yours free");
    expect(calls.join(" ")).not.toMatch(/Squirtuoz|Tourmaline|267727/);
  });

  it("settles a browser encoder that never calls back without delivering an image", async () => {
    vi.useFakeTimers();
    try {
      const png = reportPng({ toBlob: () => {} } as unknown as HTMLCanvasElement);
      const rejected = expect(png).rejects.toThrow("PNG creation took too long");
      await vi.advanceTimersByTimeAsync(20_000);
      await rejected;
    } finally { vi.useRealTimers(); }
  });
});
