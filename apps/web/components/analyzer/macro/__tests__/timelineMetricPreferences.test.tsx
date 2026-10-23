import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { act, cleanup, renderHook } from "@testing-library/react";
import { buildSeries } from "../activeArmyLayout";
import { timelineMetric } from "../timelineMetrics";
import { parseTimelineMetrics, TIMELINE_METRICS_STORAGE_KEY, useTimelineMetrics } from "../useTimelineMetrics";

beforeEach(() => localStorage.removeItem(TIMELINE_METRICS_STORAGE_KEY));
afterEach(() => { cleanup(); vi.restoreAllMocks(); localStorage.removeItem(TIMELINE_METRICS_STORAGE_KEY); });

it("plots measured mineral plus gas bank and keeps missing bank unknown", () => {
  const series = buildSeries([{ time: 0, minerals_current: 150, vespene_current: 75 }, { time: 10, minerals_current: 0, vespene_current: 0 }, { time: 20, minerals_current: 400 }], [], "my");
  expect(series.map((point) => timelineMetric("bank").read(point))).toEqual([225, 0, null]);
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
