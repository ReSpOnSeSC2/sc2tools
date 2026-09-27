import { describe, expect, test } from "vitest";
import {
  apmAt,
  formatApm,
  readGameApm,
  withApm,
  type ApmCurveResponse,
  type ApmSeries,
} from "@/lib/apm";

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
    expect(apm.me.samples).toEqual([{ t: 0, apm: 150 }]);
  });
});

describe("apmAt", () => {
  const series: ApmSeries = {
    avg: 150,
    samples: [{ t: 0, apm: 100 }, { t: 30, apm: 160 }, { t: 60, apm: 220 }],
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
    expect(apmAt({ avg: null, samples: [] }, 30, 10)).toBeNull();
  });
});

describe("withApm", () => {
  test("attaches APM at each point and leaves points alone without a series", () => {
    const points = [{ t: 0 }, { t: 45 }];
    const series: ApmSeries = { avg: 1, samples: [{ t: 0, apm: 100 }, { t: 30, apm: 160 }] };
    expect(withApm(points, series, 30)).toEqual([{ t: 0, apm: 100 }, { t: 45, apm: 160 }]);
    expect(withApm(points, null, 30)).toBe(points);
  });
});

test("formatApm rounds and shows a dash when unknown", () => {
  expect(formatApm(189.7)).toBe("190");
  expect(formatApm(null)).toBe("—");
  expect(formatApm(Number.NaN)).toBe("—");
});
