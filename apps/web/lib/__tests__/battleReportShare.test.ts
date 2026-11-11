import { afterEach, describe, expect, it, vi } from "vitest";
import { reportFixtures } from "@/lib/battleReport/__tests__/fixtures";
import { battleReportFacts } from "@/lib/battleReport/facts";
import { planBattleReport } from "@/lib/battleReport/plan";
import { battleReportImageFilename, renderBattleReportPng, reportImageMoments, reportImageParagraph } from "@/lib/battleReportImage";
import { snapshotPositions } from "@/lib/battleReport/mapSnapshot";
import { loadSharedReplayFrames } from "@/lib/battleReport/sharedReplayFrames";
import type { MapPlayback } from "@/lib/mapReplay";
import { reportPreview } from "@/lib/og/reportSnapshot";
import { shareSafeReportInput, sharedReportInput, type SharedGameAnalysis } from "@/lib/sharedGame";

const TOKEN = "AbCdEfGhIjKlMnOp";
const comeback = reportFixtures[3];
const SHARED: SharedGameAnalysis = {
  game: {
    matchup: "ZvP", myRace: "Zerg", oppRace: "Protoss", map: "Fixture comeback", result: "Win", durationSec: 960, playedOn: "2026-10-20",
    myBuild: "Zerg replay opening", oppStrategy: null, macroScore: 70, apm: null, spq: null, playerLabel: "Zerg player", playerMmr: 4200,
    playerBand: null, opponentLabel: "Opponent (Protoss, ~4,100 MMR)", opponentMmr: 4100, opponentBand: null, matchFormat: "1v1", playerCount: 2,
  },
  macroBreakdown: comeback.breakdown ?? null,
  buildOrder: { ok: true, game_id: "", my_build: null, my_race: "Zerg", opp_strategy: null, opponent: null, opp_race: "Protoss", map: null, result: null,
    events: [...(comeback.buildEvents ?? [])], opp_events: [] } as unknown as SharedGameAnalysis["buildOrder"],
  playback: { mode: "none" },
  benchmark: null,
};

const PLAYBACK: MapPlayback = {
  v: 3, mapName: "Fixture comeback", gameLength: 960, bounds: { minX: 0, minY: 0, maxX: 100, maxY: 100 },
  spawns: [], battles: [{ t: 503, x: 50, y: 50 }], resources: [], stats: { me: [], opp: [] },
  buildings: [{ owner: "me", name: "Hatchery", x: 20, y: 20, t: 0, died: null, moves: [] }],
  units: [
    { owner: "opp", name: "Probe", born: 0, died: null, wp: [0, 80, 80, 960, 80, 80] },
    { owner: "opp", name: "Zealot", born: 0, died: 400, wp: [0, 80, 80, 400, 40, 40] },
  ],
};

afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

describe("share page report input", () => {
  it("is built from the redacted payload only: race labels, no rating, the page key as seed", () => {
    const input = sharedReportInput(SHARED, `share-${TOKEN}`);
    expect(input.voice).toBe("shared");
    expect(input.game.gameId).toBe(`share-${TOKEN}`);
    expect(input.game.myMmr).toBeUndefined();
    expect(input.game.opponent).toEqual({ displayName: "a Protoss opponent", race: "Protoss", strategy: null });
    expect(shareSafeReportInput(input)).toEqual(input);
  });
});

describe("link preview report", () => {
  it("uses the share page's own headline and draws the turning point from army samples", () => {
    const preview = reportPreview(SHARED, TOKEN);
    const page = planBattleReport(battleReportFacts(sharedReportInput(SHARED, `share-${TOKEN}`)), "battle");
    expect(preview.headline).toBe(page.headline);
    expect(preview.turningPoint).not.toBeNull();
    expect(preview.turningPoint!.mine).toMatch(/^M[\d.]+,[\d.]+( L[\d.]+,[\d.]+)+$/);
    expect(preview.turningPoint!.opponent).toMatch(/^M/);
  });

  it("has no snapshot without recorded samples", () => {
    expect(reportPreview({ ...SHARED, macroBreakdown: null }, TOKEN).turningPoint).toBeNull();
  });
});

describe("recorded map snapshots", () => {
  it("projects only visible entities and the fight marker into the map frame", () => {
    const frame = snapshotPositions(PLAYBACK, 500, 200, 120);
    expect(frame?.points).toEqual([
      { x: 68.8, y: 91.2, side: "me", structure: true },
      { x: 131.2, y: 28.8, side: "opp", structure: false },
    ]);
    expect(frame?.fight).toEqual({ x: 100, y: 60 });
    expect(snapshotPositions(PLAYBACK, 961, 200, 120)).toBeNull();
    expect(JSON.stringify(frame)).not.toMatch(/Hatchery|Probe|Zealot/);
  });

  it("uses one anonymous, scoped inline recording for both requested moments", async () => {
    const fetcher = vi.fn(async () => new Response(JSON.stringify(PLAYBACK)));
    vi.stubGlobal("fetch", fetcher);
    const frames = await loadSharedReplayFrames("https://api.example", TOKEN, "inline", [500, 550]);
    expect([...frames.keys()]).toEqual([500, 550]);
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(fetcher).toHaveBeenCalledWith(`https://api.example/v1/shares/${TOKEN}/map-playback`, expect.objectContaining({ credentials: "omit", cache: "no-store" }));
    expect((await loadSharedReplayFrames("https://api.example", "invalid", "inline", [500])).size).toBe(0);
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
});

describe("report image", () => {
  const report = planBattleReport(battleReportFacts(shareSafeReportInput(comeback)), "battle");

  it("shows the turning point and the biggest fight, in game-time order", () => {
    const moments = reportImageMoments(report);
    expect(moments).toHaveLength(2);
    expect(moments[0].time).toBeLessThanOrEqual(moments[1].time);
    expect(moments.map((moment) => moment.id)).toContain("largest-swing");
    expect(battleReportImageFilename(report)).toBe("sc2-battle-report-fixture-comeback.png");
  });

  it("draws the headline, the first paragraph and two snapshots, naming no one", async () => {
    const drawn: string[] = [];
    const drawStructure = vi.fn();
    const context = new Proxy({ rect: drawStructure, measureText: (text: string) => ({ width: String(text).length * 10 }), createLinearGradient: () => ({ addColorStop: vi.fn() }) } as Record<string, unknown>, {
      get: (target, key) => key === "fillText" ? (text: string) => drawn.push(String(text)) : key in target ? target[key as string] : vi.fn(),
      set: () => true,
    });
    vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue(context as unknown as CanvasRenderingContext2D);
    vi.spyOn(HTMLCanvasElement.prototype, "toBlob").mockImplementation(function (this: HTMLCanvasElement, callback: BlobCallback) {
      callback(new Blob(["png"], { type: "image/png" }));
    });
    const blob = await renderBattleReportPng(report, { mine: comeback.breakdown?.stats_events, opponent: comeback.breakdown?.opp_stats_events, result: "Victory", playback: PLAYBACK });
    expect(blob?.type).toBe("image/png");
    expect(drawStructure).toHaveBeenCalledTimes(2);
    const text = drawn.join(" ");
    expect(text).toContain(report.headline.split(" ")[0]);
    expect(text).toContain(reportImageParagraph(report).split(" ").slice(0, 3).join(" "));
    const captions = reportImageMoments(report).map((moment) => moment.caption);
    expect(drawn.filter((line) => captions.some((caption) => line.startsWith(`${caption} · `)))).toHaveLength(2);
    for (const secret of ["Replay rival", "Replay player", "4200"]) expect(text).not.toContain(secret);
  });
});
