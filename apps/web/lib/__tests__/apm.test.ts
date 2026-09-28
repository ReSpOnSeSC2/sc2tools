import { describe, expect, test } from "vitest";
import {
  apmAt,
  formatApm,
  gamePace,
  readGameApm,
  withApm,
  type ApmCurveResponse,
  type ApmSeries,
} from "@/lib/apm";
import realCurves from "./fixtures/apmCurves.json";

const v2: ApmCurveResponse = {
  ok: true,
  v: 2,
  window_sec: 30,
  has_data: true,
  players: [
    { pid: 2, is_me: false, avg_apm: 280.5, samples: [{ t: 0, apm: 200 }, { t: 30, apm: 300 }] },
    { pid: 1, is_me: true, avg_apm: 189.7, samples: [{ t: 30, apm: 180 }, { t: 0, apm: 120 }] },
  ],
};

describe("readGameApm", () => {
  test("maps the uploader and opponent, sorting samples by time", () => {
    const apm = readGameApm(v2)!;
    expect(apm.windowSec).toBe(30);
    expect(apm.me.avg).toBe(189.7);
    expect(apm.me.samples.map((s) => s.t)).toEqual([0, 30]);
    expect(apm.opp?.avg).toBe(280.5);
  });

  test.each([
    ["no response", null],
    ["a failed read", { ...v2, ok: false }],
    ["an empty curve", { ...v2, has_data: false }],
    // Pre-0.17.2 curves credited player 2's commands to player 1.
    ["an unversioned curve", { ...v2, v: undefined }],
    ["a v1 curve", { ...v2, v: 1 }],
    ["no uploader entry", { ...v2, players: [v2.players![0]] }],
  ])("treats %s as not measured", (_label, resp) => {
    expect(readGameApm(resp as ApmCurveResponse | null)).toBeNull();
  });

  test("keeps the uploader when the opponent entry is missing", () => {
    const apm = readGameApm({ ...v2, players: [v2.players![1]] })!;
    expect(apm.opp).toBeNull();
  });

  test("drops malformed samples and non-positive averages", () => {
    const apm = readGameApm({
      ...v2,
      players: [{ is_me: true, avg_apm: 0, samples: [{ t: 0, apm: 150 }, { t: 30, apm: -1 }, { t: 60 }] }],
    })!;
    expect(apm.me.avg).toBeNull();
    expect(apm.me.samples).toEqual([{ t: 0, apm: 150, spm: null }]);
  });
});

type FixturePlayer = NonNullable<ApmCurveResponse["players"]>[number] & { name: string };
type FixtureCurve = {
  expected_spm: Record<string, number>;
  response: Omit<ApmCurveResponse, "players"> & { players: FixturePlayer[] };
};

describe("game-average SPM", () => {
  const replays = Object.entries(realCurves).filter(([key]) => key !== "_source") as Array<
    [string, FixtureCurve]
  >;

  test.each(replays)(
    "%s: matches each player's selections over their time in the game",
    (_replay, { expected_spm, response }) => {
      const apm = readGameApm(response)!;
      const [me, opp] = [
        response.players.find((p) => p.is_me)!,
        response.players.find((p) => !p.is_me)!,
      ];
      // expected_spm is counted from sc2reader events (see the fixture's _source).
      expect(apm.me.avgSpm).toBeCloseTo(expected_spm[me.name], 1);
      expect(apm.opp!.avgSpm).toBeCloseTo(expected_spm[opp.name], 1);
    },
  );

  test("runs the last window to the end of the game", () => {
    // 60 actions / 15 selections in 30 s, then 10 / 5 in a 20-second tail.
    const apm = readGameApm({
      ...v2,
      game_length_sec: 50,
      players: [{
        is_me: true,
        avg_apm: 84,
        samples: [{ t: 0, apm: 120, spm: 30 }, { t: 30, apm: 30, spm: 15 }],
      }],
    })!;
    expect(apm.me.avgSpm).toBeCloseTo(84 * 20 / 70, 6);
  });

  test("is null without every window's SPM or without an average APM", () => {
    const missing = readGameApm({
      ...v2,
      players: [{ is_me: true, avg_apm: 100, samples: [{ t: 0, apm: 100, spm: 20 }, { t: 30, apm: 100 }] }],
    })!;
    expect(missing.me.avgSpm).toBeNull();
    const noAvg = readGameApm({
      ...v2,
      players: [{ is_me: true, avg_apm: null, samples: [{ t: 0, apm: 100, spm: 20 }] }],
    })!;
    expect(noAvg.me.avgSpm).toBeNull();
    expect(gamePace(noAvg.me)).toEqual({ apm: null, spm: null });
    expect(gamePace(null)).toBeNull();
  });
});

describe("apmAt", () => {
  const series: ApmSeries = {
    avg: 150,
    avgSpm: null,
    samples: [{ t: 0, apm: 100, spm: null }, { t: 30, apm: 160, spm: null }, { t: 60, apm: 220, spm: null }],
  };

  test("holds the first and last window values beyond their middles", () => {
    expect(apmAt(series, 30, 0)).toBe(100);
    expect(apmAt(series, 30, 15)).toBe(100);
    expect(apmAt(series, 30, 75)).toBe(220);
    expect(apmAt(series, 30, 500)).toBe(220);
  });

  test("interpolates between window middles", () => {
    expect(apmAt(series, 30, 30)).toBe(130); // halfway from 15 (100) to 45 (160)
    expect(apmAt(series, 30, 45)).toBe(160);
    expect(apmAt(series, 30, 60)).toBe(190);
  });

  test("is null without samples", () => {
    expect(apmAt({ avg: null, avgSpm: null, samples: [] }, 30, 10)).toBeNull();
  });
});

describe("withApm", () => {
  test("attaches APM at each point and leaves points alone without a series", () => {
    const points = [{ t: 0 }, { t: 45 }];
    const series: ApmSeries = {
      avg: 1,
      avgSpm: null,
      samples: [{ t: 0, apm: 100, spm: null }, { t: 30, apm: 160, spm: null }],
    };
    expect(withApm(points, series, 30)).toEqual([{ t: 0, apm: 100 }, { t: 45, apm: 160 }]);
    expect(withApm(points, null, 30)).toBe(points);
  });
});

test("formatApm rounds and shows a dash when unknown", () => {
  expect(formatApm(189.7)).toBe("190");
  expect(formatApm(null)).toBe("—");
  expect(formatApm(Number.NaN)).toBe("—");
});
