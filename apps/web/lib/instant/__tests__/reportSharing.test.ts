import { describe, expect, it, vi } from "vitest";
import { buildInstantReport } from "../report";
import { realWin } from "./fixtures/reportGames";
import { defaultReportSelection, reportCardModel } from "../reportSharing";
import { reportSummaryText } from "../reportExport";
import { drawReportCard, reportPng } from "../reportCard";
import { decodeReportCard, encodeReportCard } from "../reportCardLink";

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
    const text = reportSummaryText(source, undefined, model), json = JSON.stringify(model);
    for (const privateValue of ["Squirtuoz", "Tourmaline", "267727", "unit-", "toonHandle", "pulseId", "gameId"]) {
      expect(text).not.toContain(privateValue); expect(json).not.toContain(privateValue);
    }
    const hidden = reportCardModel(source, { totals: false, matchups: [], opener: false, macro: false });
    expect(hidden).toEqual({ totals: null, matchups: [], opener: null, macro: null });
    expect(reportSummaryText(source, undefined, hidden)).not.toContain("3 games");
    expect(text).toContain("utm_medium=share");
    const fragment = encodeReportCard(model)!;
    const publicModel = decodeReportCard(fragment);
    expect(publicModel).toEqual(model);
    expect(Buffer.from(fragment, "base64url").toString()).not.toMatch(/Squirtuoz|Tourmaline|267727|unit-/);
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

  it("shares only an explicitly selected complete Commander ID and keeps v1 cards unchanged", () => {
    const source = report();
    const available = reportCardModel(source, undefined, 0);
    const defaults = defaultReportSelection(available);
    expect(defaults.commander).toBeUndefined();
    expect(encodeReportCard(reportCardModel(source, defaults, 0))).toBe(encodeReportCard(reportCardModel(source)));
    const selection = { totals: false, matchups: [], opener: false, macro: false, commander: true };
    const onlyCommander = reportCardModel(source, selection, 0);
    expect(onlyCommander).toEqual({ totals: null, matchups: [], opener: null, macro: null, commander: 0 });
    expect(reportSummaryText(source, undefined, onlyCommander)).toMatch(/Commander ID: .+Purist/);
    const bytes = Buffer.from(encodeReportCard(onlyCommander)!, "base64url");
    expect([...bytes]).toEqual([2, 1, 8, 0, 0]);
    expect(decodeReportCard(bytes.toString("base64url"))).toEqual(onlyCommander);
    expect(encodeReportCard({ ...onlyCommander, commander: 175 })).toBeNull();
    expect(reportCardModel(source, selection, 175)).not.toHaveProperty("commander");
    expect(decodeReportCard(Buffer.from([1, 1, 8, 0, 0]).toString("base64url"))).toBeNull();
  });

  it("draws the actual selected fields at1200×630 without any identity field", () => {
    const calls: string[] = [];
    const ctx = { createLinearGradient: () => ({ addColorStop: vi.fn() }), fillRect: vi.fn(),
      fillText: (value: string) => calls.push(value), measureText: (value: string) => ({ width: value.length * 10 }) };
    const canvas = { width: 0, height: 0, getContext: () => ctx } as unknown as HTMLCanvasElement;
    drawReportCard(canvas, reportCardModel(report()), "Filtered: vs Z · last 25 games");
    expect([canvas.width, canvas.height]).toEqual([1200, 630]);
    expect(calls).toContain("Filtered: vs Z · last 25 games");
    expect(calls).toContain("sc2tools.com/try — analyze yours free");
    expect(calls.join(" ")).not.toMatch(/Squirtuoz|Tourmaline|267727/);
  });

  it("gives a stand-alone Commander name a headline and keeps it below dense report rows", () => {
    const draw = vi.fn();
    const ctx = { createLinearGradient: () => ({ addColorStop: vi.fn() }), fillRect: vi.fn(), fillText: draw,
      measureText: (value: string) => ({ width: value.length * 10 }) };
    const canvas = { width: 0, height: 0, getContext: () => ctx } as unknown as HTMLCanvasElement;
    drawReportCard(canvas, { totals: null, matchups: [], opener: null, macro: null, commander: 0 });
    expect(draw).toHaveBeenCalledWith("COMMANDER ID", 60, 200);
    expect(draw).toHaveBeenCalledWith(expect.stringMatching(/Purist/), 60, 234);
    drawReportCard(canvas, { ...reportCardModel(report()), commander: 0 });
    expect(draw).toHaveBeenCalledWith(expect.stringMatching(/^Commander ID: .*Purist/), 60, 547);
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
