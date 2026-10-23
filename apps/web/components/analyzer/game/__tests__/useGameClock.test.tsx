import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { act, cleanup, renderHook } from "@testing-library/react";
import { useGameClock } from "../useGameClock";

const replace = vi.hoisted(() => vi.fn());
vi.mock("next/navigation", () => ({ useRouter: () => ({ replace }) }));
beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(0); replace.mockReset(); window.history.replaceState(null, "", "/app/game/g1?from=replays#replay"); });
afterEach(() => { cleanup(); vi.useRealTimers(); vi.restoreAllMocks(); window.history.replaceState(null, "", "/"); });

it("seeks the real stage, pauses by sequence and reveals an offscreen stage without losing the source URL", () => {
  const hook = renderHook(() => useGameClock("g1", 90, 700));
  const holder = document.createElement("div"); const stage = document.createElement("section");
  stage.setAttribute("data-replay-stage", ""); stage.tabIndex = -1; holder.appendChild(stage); document.body.appendChild(holder);
  const scroll = vi.fn(); stage.scrollIntoView = scroll;
  vi.spyOn(stage, "getBoundingClientRect").mockReturnValue(new DOMRect(0, 1400, 500, 400));
  hook.result.current.stageRef.current = holder;
  act(() => hook.result.current.seek(222));
  expect(hook.result.current.t).toBe(222); expect(hook.result.current.seekRequest).toEqual({ t: 222, seq: 1 });
  expect(scroll).toHaveBeenCalledOnce(); expect(document.activeElement).toBe(stage); expect(stage.hasAttribute("data-clock-seek")).toBe(true);
  act(() => hook.result.current.seek(222)); expect(hook.result.current.seekRequest?.seq).toBe(2);
  act(() => vi.advanceTimersByTime(500));
  expect(replace).toHaveBeenLastCalledWith("/app/game/g1?from=replays&t=222#replay", { scroll: false });
  act(() => vi.advanceTimersByTime(500)); expect(stage.hasAttribute("data-clock-seek")).toBe(false);
  holder.remove();
});

it("publishes playback at most twice per second and writes the URL only after pause", () => {
  const hook = renderHook(() => useGameClock("g1", 0, 700));
  act(() => hook.result.current.onPlaybackStateChange(true, 0));
  act(() => { for (const time of [100, 101, 102, 103]) hook.result.current.onPlaybackTimeChange(time); });
  expect(hook.result.current.t).toBe(100);
  act(() => vi.advanceTimersByTime(499)); expect(hook.result.current.t).toBe(100);
  act(() => vi.advanceTimersByTime(1)); expect(hook.result.current.t).toBe(103); expect(replace).not.toHaveBeenCalled();
  act(() => hook.result.current.onPlaybackStateChange(false, 104));
  act(() => vi.advanceTimersByTime(500)); expect(replace).toHaveBeenCalledWith("/app/game/g1?from=replays&t=104#replay", { scroll: false });
});

it("accepts external timestamp navigation without remounting and ignores its own URL acknowledgement", () => {
  const hook = renderHook(({ initial }) => useGameClock("g1", initial, 700), { initialProps: { initial: 90 } });
  act(() => hook.result.current.seek(222)); act(() => vi.advanceTimersByTime(500));
  hook.rerender({ initial: 222 }); expect(hook.result.current.seekRequest?.seq).toBe(1);
  act(() => { hook.result.current.onPlaybackStateChange(true, 222); hook.result.current.onPlaybackTimeChange(400); });
  hook.rerender({ initial: 20 }); expect(hook.result.current.t).toBe(20); expect(hook.result.current.seekRequest).toEqual({ t: 20, seq: 2 });
});

it("clamps invalid jumps, cancels a pending URL write when playing and clears timers on unmount", () => {
  const hook = renderHook(() => useGameClock("g1", 900, 700));
  expect(hook.result.current.t).toBe(700);
  act(() => { hook.result.current.seek(NaN); hook.result.current.seek(-1); }); expect(hook.result.current.seekRequest).toBeNull();
  act(() => hook.result.current.seek(800)); expect(hook.result.current.seekRequest?.t).toBe(700);
  act(() => hook.result.current.onPlaybackStateChange(true, 700)); act(() => vi.advanceTimersByTime(1000)); expect(replace).not.toHaveBeenCalled();
  act(() => hook.result.current.onPlaybackTimeChange(600)); act(() => hook.result.current.onPlaybackTimeChange(601));
  hook.unmount(); expect(vi.getTimerCount()).toBe(0);
});

it("keeps slider focus and accepts a paused-stage seek without an external seek loop", () => {
  const hook = renderHook(() => useGameClock("g1", 0, 700));
  const slider = document.createElement("input"); slider.type = "range"; document.body.appendChild(slider); slider.focus();
  act(() => hook.result.current.seek(60, { reveal: false }));
  expect(document.activeElement).toBe(slider);
  act(() => hook.result.current.onStageSeek(90));
  expect(hook.result.current.t).toBe(90); expect(hook.result.current.seekRequest).toEqual({ t: 60, seq: 1 });
  act(() => vi.advanceTimersByTime(500));
  expect(replace).toHaveBeenLastCalledWith("/app/game/g1?from=replays&t=90#replay", { scroll: false });
  slider.remove();
});
