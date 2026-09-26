import { act, cleanup, render } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { MapReplayer } from "../../MapReplayer";
import { sanitizeMapPlayback } from "@/lib/mapReplay";
import { makePlayback } from "@/lib/__tests__/segmentedPlayback.fixture";

afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });
it("waits at the exact segment boundary, freezes while buffering, and resumes the same clock", () => {
  const context = new Proxy({}, { get: (_target, key) => key === "createRadialGradient"
    ? () => ({ addColorStop() {} }) : key === "measureText" ? () => ({ width: 0 }) : () => undefined,
    set: () => true });
  vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue(context as CanvasRenderingContext2D);
  const frames = new Map<number, FrameRequestCallback>();
  let nextId = 0;
  vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => { frames.set(++nextId, callback); return nextId; });
  vi.stubGlobal("cancelAnimationFrame", (id: number) => frames.delete(id));
  const frame = (time: number) => act(() => {
    const pending = [...frames.values()]; frames.clear(); pending.forEach(callback => callback(time));
  });
  const raw = makePlayback(); raw.units = []; raw.buildings[0].name = "Unknown";
  const playback = sanitizeMapPlayback(raw)!;
  const onTimeChange = vi.fn();
  const shared = { playback, time: 59.95, playing: true, speed: 1 as const, onTimeChange };
  const view = render(<MapReplayer {...shared} playbackWindow={{ start: 0, end: 60 }} />);
  frame(0); frame(100);
  expect(onTimeChange).toHaveBeenLastCalledWith(60);
  frame(3000); expect(onTimeChange.mock.calls.every(([time]) => time <= 60)).toBe(true);
  view.rerender(<MapReplayer {...shared} time={60} playbackWindow={{ start: 0, end: 60 }} buffering />);
  onTimeChange.mockClear(); frame(5000); expect(onTimeChange).not.toHaveBeenCalled();
  view.rerender(<MapReplayer {...shared} time={60} playbackWindow={{ start: 60, end: 120 }} />);
  frame(5500); expect(onTimeChange).toHaveBeenLastCalledWith(60.5);
});
