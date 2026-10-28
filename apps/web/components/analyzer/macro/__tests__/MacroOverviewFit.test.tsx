import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { useState } from "react";
import { MacroOverviewFit } from "../MacroOverviewFit";
import { macroOverviewLayout, MIN_OVERVIEW_SCALE } from "../macroOverviewLayout";

let width = 296;
let height = 700;
let top = 200;
const observers: ResizeObserverCallback[] = [];

function updateSize() {
  act(() => { for (const callback of observers) callback([], {} as ResizeObserver); });
}
function overview() { return screen.getByRole("region", { name: "Timeline and both armies" }); }
function content() { return overview().querySelector<HTMLElement>("[data-macro-overview-content]")!; }
function reservation() { return overview().querySelector<HTMLElement>("[data-macro-overview-reservation]")!; }
function Counter() {
  const [count, setCount] = useState(0);
  return <button type="button" onClick={() => setCount(count + 1)}>Selected unit {count}</button>;
}

beforeEach(() => {
  width = 296; height = 700; top = 200; observers.length = 0;
  vi.spyOn(HTMLElement.prototype, "clientWidth", "get").mockImplementation(function (this: HTMLElement) { return this.hasAttribute("data-macro-overview-viewport") ? width : 0; });
  vi.spyOn(HTMLElement.prototype, "offsetHeight", "get").mockImplementation(function (this: HTMLElement) { return this.hasAttribute("data-macro-overview-content") ? height : 0; });
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (this: HTMLElement) { return new DOMRect(0, this.hasAttribute("data-macro-overview-viewport") ? top : 0, width, height); });
  vi.stubGlobal("innerHeight", 800);
  vi.stubGlobal("ResizeObserver", class {
    constructor(callback: ResizeObserverCallback) { observers.push(callback); }
    observe() {}
    disconnect() {}
  });
});
afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

describe("Macro modal overview", () => {
  it("reserves only the scaled physical box and caps shrinking at usable roster targets", () => {
    render(<MacroOverviewFit gameId="one"><Counter /></MacroOverviewFit>);
    const scale = Number(content().style.transform.match(/[\d.]+/)![0]);
    expect(scale).toBeCloseTo(MIN_OVERVIEW_SCALE);
    expect(parseFloat(reservation().style.width)).toBeCloseTo(width);
    expect(parseFloat(reservation().style.height)).toBe(Math.ceil(height * scale));
    expect(reservation().style.overflow).toBe("clip");
    expect(content().style.position).toBe("absolute");
    expect(overview().hasAttribute("tabindex")).toBe(false);
    expect(44 * scale).toBeGreaterThanOrEqual(24);
    // Dense data remains in the reachable local scroll region rather than being hidden.
    height = 1400; updateSize();
    expect(parseFloat(reservation().style.height)).toBeGreaterThan(parseFloat(overview().style.maxHeight));
    const keyboardEntry = screen.getByRole("button", { name: "Selected unit 0" });
    keyboardEntry.focus();
    expect(document.activeElement).toBe(keyboardEntry);
    expect(overview().contains(keyboardEntry)).toBe(true);
  });

  it("zooms locally through readable sizes, preserves child selection and returns to Fit", () => {
    render(<MacroOverviewFit gameId="one"><Counter /></MacroOverviewFit>);
    const child = screen.getByRole("button", { name: "Selected unit 0" });
    fireEvent.click(child);
    child.focus();
    const zoomIn = screen.getByRole("button", { name: "Zoom in timeline and armies" });
    for (const scale of [0.75, 1, 1.25, 1.5]) {
      fireEvent.click(zoomIn);
      expect(content().style.transform).toBe(`scale(${scale})`);
      expect(screen.getByRole("button", { name: "Selected unit 1" })).toBe(child);
      expect(document.activeElement).toBe(child);
    }
    expect((zoomIn as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(screen.getByRole("button", { name: "Zoom out timeline and armies" }));
    expect(content().style.transform).toBe("scale(1.25)");
    fireEvent.click(screen.getByRole("button", { name: "Fit" }));
    expect(screen.getByRole("button", { name: "Fit" }).getAttribute("aria-pressed")).toBe("true");
    expect(parseFloat(reservation().style.width)).toBeCloseTo(width);
  });

  it("recomputes Fit for content and orientation, while manual zoom stays local until game or exit reset", () => {
    const view = render(<MacroOverviewFit gameId="one"><Counter /></MacroOverviewFit>);
    width = 366; height = 800; updateSize();
    expect(parseFloat(content().style.width)).toBe(576);
    expect(parseFloat(reservation().style.width)).toBeCloseTo(width);
    fireEvent.click(screen.getByRole("button", { name: "Zoom in timeline and armies" }));
    width = 700; updateSize();
    expect(content().style.transform).toBe("scale(0.75)");
    overview().scrollTop = 100; overview().scrollLeft = 20;
    view.rerender(<MacroOverviewFit gameId="two"><Counter /></MacroOverviewFit>);
    expect(screen.getByRole("button", { name: "Fit" }).getAttribute("aria-pressed")).toBe("true");
    expect([overview().scrollTop, overview().scrollLeft]).toEqual([0, 0]);
    fireEvent.click(screen.getByRole("button", { name: "Zoom in timeline and armies" }));
    view.rerender(<MacroOverviewFit gameId="one"><Counter /></MacroOverviewFit>);
    expect(screen.getByRole("button", { name: "Fit" }).getAttribute("aria-pressed")).toBe("true");
    view.unmount();
    render(<MacroOverviewFit gameId="one"><Counter /></MacroOverviewFit>);
    expect(screen.getByRole("button", { name: "Fit" }).getAttribute("aria-pressed")).toBe("true");
  });

  it("never changes document zoom, font size, viewport metadata, persistence or page scroll", () => {
    const meta = document.createElement("meta"); meta.name = "viewport"; meta.content = "width=device-width, initial-scale=1"; document.head.append(meta);
    const setItem = vi.spyOn(Storage.prototype, "setItem");
    const scroll = vi.spyOn(window, "scrollTo").mockImplementation(() => undefined);
    const before = [document.documentElement.style.cssText, document.body.style.cssText, meta.content];
    render(<MacroOverviewFit><Counter /></MacroOverviewFit>);
    fireEvent.click(screen.getByRole("button", { name: "Zoom in timeline and armies" }));
    fireEvent.click(screen.getByRole("button", { name: "Fit" }));
    expect([document.documentElement.style.cssText, document.body.style.cssText, meta.content]).toEqual(before);
    expect(setItem).not.toHaveBeenCalled(); expect(scroll).not.toHaveBeenCalled();
    meta.remove();
  });

  it("keeps late content in normal flow when live size observation is unavailable", () => {
    vi.stubGlobal("ResizeObserver", undefined);
    const view = render(<MacroOverviewFit><p>Loading roster</p></MacroOverviewFit>);
    expect(screen.queryByRole("button", { name: "Zoom in timeline and armies" })).toBeNull();
    expect(content().style.transform).toBe("");
    expect(content().style.position).toBe("");
    expect(reservation().style.height).toBe("");
    view.rerender(<MacroOverviewFit><p>Both completed rosters remain reachable</p></MacroOverviewFit>);
    expect(screen.getByText("Both completed rosters remain reachable")).toBeTruthy();
    expect(reservation().style.overflow).toBe("");
  });
});

describe("overview layout", () => {
  it.each([296, 366, 640, 1200])("contains the full width at Fit for %dpx, including a short landscape viewport", (availableWidth) => {
    const layout = macroOverviewLayout(availableWidth, 1800, 160);
    expect(layout.logicalWidth * layout.fit).toBeLessThanOrEqual(availableWidth + 0.001);
    expect(layout.fit * 44).toBeGreaterThanOrEqual(24);
    expect(layout.logicalWidth).toBeGreaterThanOrEqual(availableWidth);
  });
});
