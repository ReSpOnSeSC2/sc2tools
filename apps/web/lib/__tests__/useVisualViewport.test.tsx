import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { useVisualViewport } from "../useVisualViewport";

afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

it("tracks zoom, keyboard height and panning only while active, then removes listeners", () => {
  const viewport = Object.assign(new EventTarget(), { width: 390, height: 844, offsetLeft: 0, offsetTop: 0 });
  const remove = vi.spyOn(viewport, "removeEventListener");
  vi.stubGlobal("visualViewport", viewport);
  const { result, rerender } = renderHook(({ active }) => useVisualViewport(active), { initialProps: { active: false } });
  expect(result.current).toBeNull();
  rerender({ active: true });
  expect(result.current).toEqual({ width: 390, height: 844, left: 0, top: 0 });
  act(() => {
    Object.assign(viewport, { width: 260, height: 400 });
    viewport.dispatchEvent(new Event("resize"));
  });
  expect(result.current).toEqual({ width: 260, height: 400, left: 0, top: 0 });
  act(() => {
    Object.assign(viewport, { offsetLeft: 40, offsetTop: 90 });
    viewport.dispatchEvent(new Event("scroll"));
  });
  expect(result.current).toEqual({ width: 260, height: 400, left: 40, top: 90 });
  rerender({ active: false });
  expect(result.current).toBeNull();
  expect(remove.mock.calls.map(([event]) => event)).toEqual(["resize", "scroll"]);
});

it("falls back to layout viewport CSS without the Visual Viewport API", () => {
  vi.stubGlobal("visualViewport", undefined);
  const { result } = renderHook(() => useVisualViewport(true));
  expect(result.current).toBeNull();
});
