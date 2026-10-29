import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { useState } from "react";
import { createPortal } from "react-dom";
import { MacroOverviewFit } from "../MacroOverviewFit";
import { macroOverviewLayout, MACRO_OVERVIEW_SCALE } from "../macroOverviewLayout";

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
  it("reserves the fixed 50% box and keeps 48px roster targets at 24 physical pixels", () => {
    render(<MacroOverviewFit gameId="one"><Counter /></MacroOverviewFit>);
    const scale = Number(content().style.transform.match(/[\d.]+/)![0]);
    expect(scale).toBe(MACRO_OVERVIEW_SCALE);
    expect(parseFloat(reservation().style.width)).toBeCloseTo(width);
    expect(parseFloat(reservation().style.height)).toBe(Math.ceil(height * scale));
    expect(reservation().style.overflow).toBe("clip");
    expect(content().style.position).toBe("absolute");
    expect(overview().hasAttribute("tabindex")).toBe(false);
    expect(48 * scale).toBe(24);
    // Dense data remains in the reachable local scroll region rather than being hidden.
    height = 1400; updateSize();
    expect(parseFloat(reservation().style.height)).toBeGreaterThan(parseFloat(overview().style.maxHeight));
    const keyboardEntry = screen.getByRole("button", { name: "Selected unit 0" });
    keyboardEntry.focus();
    expect(document.activeElement).toBe(keyboardEntry);
    expect(overview().contains(keyboardEntry)).toBe(true);
  });

  it("has no zoom controls and preserves selection and focus while its fixed view resizes", () => {
    render(<MacroOverviewFit gameId="one"><Counter /></MacroOverviewFit>);
    const child = screen.getByRole("button", { name: "Selected unit 0" });
    fireEvent.click(child);
    child.focus();
    for (const availableWidth of [296, 366, 700, 296]) {
      width = availableWidth; updateSize();
      expect(content().style.transform).toBe("scale(0.5)");
      expect(parseFloat(reservation().style.width)).toBe(width);
      expect(screen.getByRole("button", { name: "Selected unit 1" })).toBe(child);
      expect(document.activeElement).toBe(child);
    }
    expect(screen.queryByRole("group", { name: "Timeline and armies zoom" })).toBeNull();
    expect(screen.queryByRole("button", { name: /Zoom in|Zoom out|^Fit$/ })).toBeNull();
    expect(screen.queryByText(/Zoom in for detail/)).toBeNull();
  });

  it("stays at 50% through late data, orientation and game changes, resetting local scroll on reopen", () => {
    const view = render(<MacroOverviewFit gameId="one"><Counter /></MacroOverviewFit>);
    width = 366; height = 800; updateSize();
    expect(parseFloat(content().style.width)).toBe(732);
    expect(parseFloat(reservation().style.width)).toBeCloseTo(width);
    width = 700; updateSize();
    expect(content().style.transform).toBe("scale(0.5)");
    expect(parseFloat(reservation().style.width)).toBe(width);
    overview().scrollTop = 100; overview().scrollLeft = 20;
    view.rerender(<MacroOverviewFit gameId="two"><Counter /></MacroOverviewFit>);
    expect(content().style.transform).toBe("scale(0.5)");
    expect([overview().scrollTop, overview().scrollLeft]).toEqual([0, 0]);
    view.rerender(<MacroOverviewFit gameId="one"><Counter /></MacroOverviewFit>);
    expect(content().style.transform).toBe("scale(0.5)");
    view.unmount();
    render(<MacroOverviewFit gameId="one"><Counter /></MacroOverviewFit>);
    expect(content().style.transform).toBe("scale(0.5)");
  });

  it("never changes document zoom, font size, viewport metadata, persistence or page scroll", () => {
    const meta = document.createElement("meta"); meta.name = "viewport"; meta.content = "width=device-width, initial-scale=1"; document.head.append(meta);
    const setItem = vi.spyOn(Storage.prototype, "setItem");
    const scroll = vi.spyOn(window, "scrollTo").mockImplementation(() => undefined);
    const before = [document.documentElement.style.cssText, document.body.style.cssText, meta.content];
    render(<MacroOverviewFit><Counter /></MacroOverviewFit>);
    fireEvent.click(screen.getByRole("button", { name: "Selected unit 0" }));
    width = 366; height = 1200; updateSize();
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

  it("keeps vertical keyboard scrolling local through both edges of an overflowing overview", () => {
    render(<MacroOverviewFit><Counter /></MacroOverviewFit>);
    const viewport = overview(), button = screen.getByRole("button", { name: "Selected unit 0" });
    Object.defineProperties(viewport, { clientHeight: { value: 160 }, scrollHeight: { value: 400 } });
    const pageScroll = vi.spyOn(window, "scrollTo").mockImplementation(() => undefined);
    for (let index = 0; index < 8; index++) expect(fireEvent.keyDown(button, { key: "ArrowDown" })).toBe(false);
    expect(viewport.scrollTop).toBe(240);
    for (const [key, position] of [["PageUp", 80], ["ArrowUp", 40], ["Home", 0], ["End", 240]] as const) {
      expect(fireEvent.keyDown(button, { key })).toBe(false);
      expect(viewport.scrollTop).toBe(position);
    }
    expect(pageScroll).not.toHaveBeenCalled();
    for (const key of ["Enter", "ArrowLeft", "constructor", "toString"]) {
      expect(fireEvent.keyDown(button, { key })).toBe(true);
      expect(viewport.scrollTop).toBe(240);
    }
  });

  it("leaves modifiers, editables and a child's handled keys alone", () => {
    render(<MacroOverviewFit><Counter /><input aria-label="Editable" />
      <span contentEditable="plaintext-only" suppressContentEditableWarning data-testid="editable">Text</span>
      <button onKeyDown={(event) => event.preventDefault()}>Handled</button></MacroOverviewFit>);
    const viewport = overview(), button = screen.getByRole("button", { name: "Selected unit 0" });
    Object.defineProperties(viewport, { clientHeight: { value: 160 }, scrollHeight: { value: 400 } });
    viewport.scrollTop = 80;
    for (const modifier of ["altKey", "ctrlKey", "metaKey", "shiftKey"]) {
      expect(fireEvent.keyDown(button, { key: "ArrowDown", [modifier]: true })).toBe(true);
    }
    expect(fireEvent.keyDown(screen.getByLabelText("Editable"), { key: "ArrowDown" })).toBe(true);
    const editable = screen.getByTestId("editable");
    // jsdom does not compute the browser's inherited contenteditable property.
    Object.defineProperty(editable, "isContentEditable", { value: true });
    expect(fireEvent.keyDown(editable, { key: "PageDown" })).toBe(true);
    expect(fireEvent.keyDown(screen.getByRole("button", { name: "Handled" }), { key: "End" })).toBe(false);
    expect(viewport.scrollTop).toBe(80);
  });

  it("does not intercept keys bubbling from an unscaled nested detail portal", () => {
    render(<MacroOverviewFit><Counter />{createPortal(<button>Nested detail</button>, document.body)}</MacroOverviewFit>);
    const viewport = overview();
    Object.defineProperties(viewport, { clientHeight: { value: 160 }, scrollHeight: { value: 400 } });
    viewport.scrollTop = 55;
    for (const key of ["PageDown", "Home", "End"]) {
      expect(fireEvent.keyDown(screen.getByRole("button", { name: "Nested detail" }), { key })).toBe(true);
      expect(viewport.scrollTop).toBe(55);
    }
  });

  it("leaves ordinary page scrolling available when the overview does not overflow", () => {
    render(<MacroOverviewFit><Counter /></MacroOverviewFit>);
    const viewport = overview();
    Object.defineProperties(viewport, { clientHeight: { value: 160 }, scrollHeight: { value: 160 } });
    expect(fireEvent.keyDown(screen.getByRole("button", { name: "Selected unit 0" }), { key: "PageDown" })).toBe(true);
    expect(viewport.scrollTop).toBe(0);
  });
});

describe("overview layout", () => {
  it.each([296, 366, 640, 1200])("contains the full width at Fit for %dpx, including a short landscape viewport", (availableWidth) => {
    const layout = macroOverviewLayout(availableWidth);
    expect(layout.scale).toBe(0.5);
    expect(layout.logicalWidth * layout.scale).toBe(availableWidth);
    expect(layout.scale * 48).toBe(24);
    expect(layout.logicalWidth).toBeGreaterThanOrEqual(availableWidth);
  });
});
