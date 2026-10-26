import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { act, cleanup, renderHook } from "@testing-library/react";
import { buildLayout, buildSeries, nearestPriorPoint } from "../activeArmyLayout";
import { timelineMetric } from "../timelineMetrics";
import { parseTimelineBankView, parseTimelineMetrics, TIMELINE_BANK_VIEW_STORAGE_KEY, TIMELINE_METRICS_STORAGE_KEY, useTimelineBankView, useTimelineMetrics } from "../useTimelineMetrics";

beforeEach(() => { localStorage.removeItem(TIMELINE_METRICS_STORAGE_KEY); localStorage.removeItem(TIMELINE_BANK_VIEW_STORAGE_KEY); });
afterEach(() => { cleanup(); vi.restoreAllMocks(); localStorage.removeItem(TIMELINE_METRICS_STORAGE_KEY); localStorage.removeItem(TIMELINE_BANK_VIEW_STORAGE_KEY); });

it("plots measured mineral plus gas bank and keeps missing bank unknown", () => {
  const series = buildSeries([{ time: 0, minerals_current: 150, vespene_current: 75 }, { time: 10, minerals_current: 0, vespene_current: 0 }, { time: 20, minerals_current: 400 }], [], "my");
  expect(series.map((point) => timelineMetric("bank").read(point))).toEqual([225, 0, null]);
});

it("keeps measured bank components independent and does not turn missing or invalid resources into zero", () => {
  const series = buildSeries([
    { time: 0, minerals_current: 150, vespene_current: 75 },
    { time: 10, minerals_current: 0, vespene_current: 0 },
    { time: 20, minerals_current: 400 },
    { time: 30, vespene_current: 80 },
    { time: 40, minerals_current: -1, vespene_current: 60 },
    { time: 50, minerals_current: Number.POSITIVE_INFINITY, vespene_current: 0 },
  ], [], "my");
  expect(series.map((p) => timelineMetric("bank", "minerals").read(p))).toEqual([150, 0, 400, null, null, null]);
  expect(series.map((p) => timelineMetric("bank", "gas").read(p))).toEqual([75, 0, null, 80, 60, 0]);
  expect(series.map((p) => timelineMetric("bank").read(p))).toEqual([225, 0, null, null, null, null]);
  const prior = nearestPriorPoint(series, 25)!;
  expect([prior.t, prior.bank, prior.bankMinerals, prior.bankGas]).toEqual([20, undefined, 400, undefined]);
});

it("uses the chosen Bank resource for both player tracks and keeps the existing metric mix", () => {
  const mine = buildSeries([{ time: 0, minerals_current: 1000, vespene_current: 50 }, { time: 30, minerals_current: 2000, vespene_current: 100 }], [], "my");
  const theirs = buildSeries([{ time: 0, minerals_current: 500, vespene_current: 75 }, { time: 30, minerals_current: 400, vespene_current: 150 }], [], "opp");
  const total = buildLayout(mine, theirs, 30, { metrics: ["bank"] })!;
  const gas = buildLayout(mine, theirs, 30, { metrics: ["bank"], bankView: "gas" })!;
  expect(total.tracks[0].metric.read(mine[1])).toBe(2100);
  expect(gas.tracks[0].metric.read(mine[1])).toBe(100);
  expect(gas.tracks[0].metric.read(theirs[1])).toBe(150);
  expect(gas.tracks[0].yMax).toBeLessThan(total.tracks[0].yMax);
  expect(buildLayout(mine, theirs, 30, { metrics: ["army", "bank"], bankView: "minerals" })!.tracks.map((track) => track.metric.key)).toEqual(["army", "bank"]);
});

it("loads known metric choices and ignores corrupt or future keys", () => {
  expect(parseTimelineMetrics('["workers","future","bank","workers"]')).toEqual(["workers", "bank"]);
  expect(parseTimelineMetrics('["future"]')).toEqual(["army"]);
  expect(parseTimelineMetrics('{"workers":true}')).toEqual(["army"]);
  expect(parseTimelineMetrics("broken")).toEqual(["army"]);
  expect(parseTimelineMetrics("[]")).toEqual([]);
});

it("remembers the user's mix across unmounts without overwriting it on first render", () => {
  localStorage.setItem(TIMELINE_METRICS_STORAGE_KEY, '["workers","bank"]');
  const first = renderHook(() => useTimelineMetrics());
  expect(first.result.current[0]).toEqual(["workers", "bank"]);
  act(() => first.result.current[1](["supply", "income"]));
  first.unmount();
  expect(renderHook(() => useTimelineMetrics()).result.current[0]).toEqual(["supply", "income"]);
});

it("keeps chart controls usable when storage is unavailable", () => {
  vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => { throw new Error("blocked"); });
  vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => { throw new Error("blocked"); });
  const hook = renderHook(() => useTimelineMetrics());
  expect(hook.result.current[0]).toEqual(["army"]);
  act(() => hook.result.current[1](["bank"]));
  expect(hook.result.current[0]).toEqual(["bank"]);
});

it("validates and remembers the separate Bank view without changing the saved metric mix", () => {
  expect(parseTimelineBankView(null)).toBe("total");
  for (const raw of ['"future"', '[]', '{}', 'broken']) expect(parseTimelineBankView(raw)).toBe("total");
  localStorage.setItem(TIMELINE_METRICS_STORAGE_KEY, '["workers","bank"]');
  localStorage.setItem(TIMELINE_BANK_VIEW_STORAGE_KEY, '"gas"');
  const first = renderHook(() => useTimelineBankView());
  expect(first.result.current[0]).toBe("gas");
  act(() => first.result.current[1]("minerals")); first.unmount();
  expect(renderHook(() => useTimelineBankView()).result.current[0]).toBe("minerals");
  expect(localStorage.getItem(TIMELINE_METRICS_STORAGE_KEY)).toBe('["workers","bank"]');
});

it("keeps Bank resource selection usable when browser storage is blocked", () => {
  vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => { throw new Error("blocked"); });
  vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => { throw new Error("blocked"); });
  const hook = renderHook(() => useTimelineBankView());
  expect(hook.result.current[0]).toBe("total");
  act(() => hook.result.current[1]("gas"));
  expect(hook.result.current[0]).toBe("gas");
});
