import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useElapsedReveal, useEliminationSchedule, useRaf } from "./spriteShared";

let nextId: number;
let callbacks: Map<number, FrameRequestCallback>;
function frame(at: number) {
  const pending = [...callbacks.values()];
  callbacks.clear();
  act(() => pending.forEach((callback) => callback(at)));
}

beforeEach(() => {
  nextId = 1;
  callbacks = new Map();
  vi.spyOn(performance, "now").mockReturnValue(0);
  vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
    const id = nextId++;
    callbacks.set(id, callback);
    return id;
  });
  vi.stubGlobal("cancelAnimationFrame", (id: number) => callbacks.delete(id));
});
afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

describe("motion frame budget", () => {
  it("limits a 144Hz browser to 30 updates per second and retains wall-clock elapsed time", () => {
    const callback = vi.fn();
    renderHook(() => useRaf(true, 1, callback));
    for (let index = 1; index <= 144; index++) frame(index * 1000 / 144);
    expect(callback.mock.calls.length).toBeLessThanOrEqual(30);
    expect(callback.mock.calls.length).toBeGreaterThanOrEqual(24);
    expect(callback.mock.calls.at(-1)![1]).toBeGreaterThan(960);
    expect(callback.mock.calls[0][0]).toBeGreaterThanOrEqual(1000 / 30 - 0.01);
  });

  it("keeps a single loop across rerenders, updates its callback and cancels when inactive", () => {
    const first = vi.fn(), second = vi.fn();
    const view = renderHook(({ active, callback }) => useRaf(active, 4, callback), { initialProps: { active: true, callback: first } });
    expect(callbacks.size).toBe(1);
    frame(40);
    view.rerender({ active: true, callback: second });
    expect(callbacks.size).toBe(1);
    frame(80);
    expect(first).toHaveBeenCalledTimes(1);
    expect(second).toHaveBeenCalledWith(40, 80);
    view.rerender({ active: false, callback: second });
    expect(callbacks.size).toBe(0);
  });

  it("completes a reveal at its original duration and stops requesting frames", () => {
    const complete = vi.fn();
    const view = renderHook(() => useElapsedReveal(3, 1000, false, complete));
    for (let elapsed = 40; elapsed <= 1000; elapsed += 40) frame(elapsed);
    expect(view.result.current).toEqual({ elapsed: 1000, settled: true });
    expect(complete).toHaveBeenCalledTimes(1);
    expect(callbacks.size).toBe(0);
  });

  it("schedules only shown knockouts at their original full-pool deadlines", () => {
    vi.useFakeTimers();
    const full = Array.from({ length: 100 }, (_, index) => `loser-${index}`);
    const tracked = new Set(["loser-0", "loser-49", "loser-99"]);
    const complete = vi.fn();
    const view = renderHook(() => useEliminationSchedule(5, full, 10100, false, complete, tracked));
    expect(vi.getTimerCount()).toBe(4);
    expect(view.result.current.nextOutId).toBe("loser-0");
    act(() => vi.advanceTimersByTime(99));
    expect(view.result.current.eliminated.size).toBe(0);
    act(() => vi.advanceTimersByTime(1));
    expect([...view.result.current.eliminated]).toEqual(["loser-0"]);
    expect(view.result.current.nextOutId).toBe("loser-49");
    act(() => vi.advanceTimersByTime(4900));
    expect([...view.result.current.eliminated]).toEqual(["loser-0", "loser-49"]);
    expect(view.result.current.nextOutId).toBe("loser-99");
    act(() => vi.advanceTimersByTime(5000));
    expect(view.result.current.eliminated.size).toBe(3);
    expect(view.result.current.nextOutId).toBeNull();
    expect(complete).not.toHaveBeenCalled();
    act(() => vi.advanceTimersByTime(100));
    expect(view.result.current.settled).toBe(true);
    expect(complete).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
    vi.useRealTimers();
  });
});
