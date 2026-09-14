import { useState } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { DeferredTrendsExplorer } from "./DeferredTrendsExplorer";

const renderExplorer = vi.hoisted(() => vi.fn());
vi.mock("./TrendsExplorer", () => ({
  TrendsExplorer: ({ isNearViewport }: { isNearViewport: boolean }) => {
    renderExplorer(isNearViewport);
    const [value, setValue] = useState("MMR difference");
    return <button type="button" onClick={() => setValue("Compare periods")}>{value}</button>;
  },
}));

function mockObserver() {
  let callback: IntersectionObserverCallback;
  const disconnect = vi.fn();
  const observe = vi.fn();
  const constructor = vi.fn();
  vi.stubGlobal("IntersectionObserver", class {
    constructor(handler: IntersectionObserverCallback, options: IntersectionObserverInit) { callback = handler; constructor(options); }
    observe = observe;
    disconnect = disconnect;
  });
  return { notify: (isIntersecting: boolean) => act(() => callback([{ isIntersecting } as IntersectionObserverEntry], {} as IntersectionObserver)), constructor, disconnect, observe };
}

afterEach(() => { cleanup(); vi.unstubAllGlobals(); renderExplorer.mockClear(); });

describe("deferred Trends explorer", () => {
  it("does not mount or fetch until near the viewport, then preserves the selected analysis", () => {
    const observer = mockObserver();
    const rendered = render(<DeferredTrendsExplorer />);
    expect(renderExplorer).not.toHaveBeenCalled();
    expect(observer.constructor).toHaveBeenCalledWith({ rootMargin: "400px 0px" });
    observer.notify(false);
    expect(renderExplorer).not.toHaveBeenCalled();
    observer.notify(true);
    expect(renderExplorer).toHaveBeenLastCalledWith(true);
    const analysis = screen.getByRole("button", { name: "MMR difference" });
    fireEvent.click(analysis);
    expect(screen.getByRole("button", { name: "Compare periods" })).toBe(analysis);
    observer.notify(false);
    expect(screen.getByRole("button", { name: "Compare periods" })).toBe(analysis);
    expect(renderExplorer).toHaveBeenLastCalledWith(false);
    observer.notify(true);
    expect(renderExplorer).toHaveBeenLastCalledWith(true);
    expect(screen.getByRole("button", { name: "Compare periods" })).toBe(analysis);
    expect(observer.disconnect).not.toHaveBeenCalled();
    rendered.unmount();
    expect(observer.disconnect).toHaveBeenCalledTimes(1);
  });

  it("offers explicit loading before the visibility observer fires", () => {
    mockObserver();
    render(<DeferredTrendsExplorer />);
    fireEvent.click(screen.getByRole("button", { name: "Load analyses" }));
    expect(screen.getByRole("button", { name: "MMR difference" })).toBeTruthy();
  });

  it("loads automatically when visibility observation is unavailable", () => {
    vi.stubGlobal("IntersectionObserver", undefined);
    render(<DeferredTrendsExplorer />);
    expect(screen.getByRole("button", { name: "MMR difference" })).toBeTruthy();
  });
});
