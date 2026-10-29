import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { MacroChartSection } from "../MacroChartSection";
import type { StatsEvent } from "../MacroBreakdownPanel.types";

vi.mock("@/lib/clientApi", () => ({ useApi: () => ({ data: { events: [], opp_events: [] }, isLoading: false, error: null }) }));
const samples: StatsEvent[] = [{ time: 0, army_value: 0, food_workers: 12 }, { time: 75, army_value: 725, food_workers: 24 }, { time: 300, army_value: 3025, food_workers: 48 }];
const originalScrollIntoView = Object.getOwnPropertyDescriptor(Element.prototype, "scrollIntoView");
const scroll = vi.fn();

beforeEach(() => {
  localStorage.clear();
  scroll.mockClear();
  Object.defineProperty(Element.prototype, "scrollIntoView", { configurable: true, value: scroll });
  vi.stubGlobal("ResizeObserver", class {
    constructor(private callback: ResizeObserverCallback) {}
    observe(target: Element) { this.callback([{ target, contentRect: new DOMRect(0, 0, 576, 220) }] as ResizeObserverEntry[], this as unknown as ResizeObserver); }
    disconnect() {}
  });
});
afterEach(() => {
  cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals();
  if (originalScrollIntoView) Object.defineProperty(Element.prototype, "scrollIntoView", originalScrollIntoView);
  else Reflect.deleteProperty(Element.prototype, "scrollIntoView");
});

describe("fitted timeline and compositions", () => {
  it("keeps every metric, bank and supply control outside the transform and casualties outside the overview", () => {
    render(<MacroChartSection fitOverview samples={samples} oppSamples={samples} leaks={[]} gameLengthSec={300} supplyBlockWindows={[{ start: 60, end: 90 }]} />);
    const stage = screen.getByRole("region", { name: "Timeline and both armies" });
    expect(stage.contains(screen.getByRole("group", { name: "Chart metrics" }))).toBe(false);
    expect(stage.contains(screen.getByRole("switch", { name: "Show supply blocks" }))).toBe(false);
    fireEvent.click(screen.getByRole("button", { name: "Bank" }));
    expect(stage.contains(screen.getByRole("group", { name: "Bank resource" }))).toBe(false);
    expect(within(stage).queryByRole("group", { name: "Chart metrics" })).toBeNull();
    expect(stage.contains(screen.getByRole("heading", { name: "Killed & lost", hidden: true }))).toBe(false);
  });

  it("uses the physical transformed plot fraction once, preserving both rosters and passive inspection through late data", () => {
    const onSeek = vi.fn();
    const view = render(<MacroChartSection fitOverview gameId="one" samples={samples} oppSamples={samples} leaks={[]} gameLengthSec={300} onSeek={onSeek} />);
    const chart = screen.getByRole("img", { name: /Army value/ });
    const overlay = chart.querySelector<SVGRectElement>('rect[fill="transparent"]')!;
    // Logical600px plot shown at50%: a physical75px is75s, not150s.
    vi.spyOn(overlay, "getBoundingClientRect").mockReturnValue(new DOMRect(20, 0, 300, 110));
    fireEvent.click(overlay, { clientX: 95, clientY: 40 });
    expect(onSeek).toHaveBeenCalledTimes(1); expect(onSeek).toHaveBeenCalledWith(75);
    for (const name of ["You composition at 1:15", "Opponent composition at 1:15"]) expect(screen.getByRole("region", { name })).toBeTruthy();
    expect(screen.queryByRole("group", { name: "Timeline and armies zoom" })).toBeNull();
    const later = [...samples, { time: 360, army_value: 3400, food_workers: 50 }];
    view.rerender(<MacroChartSection fitOverview gameId="one" samples={later} oppSamples={later} leaks={[]} gameLengthSec={360} onSeek={onSeek} />);
    expect(screen.getByRole("img", { name: /Army value/ })).toBe(chart);
    expect(screen.getByRole("region", { name: "You composition at 1:15" })).toBeTruthy();
    expect(onSeek).toHaveBeenCalledTimes(1); expect(scroll).not.toHaveBeenCalled();
  });

  it("reveals a clipped focused metric using only the fitted row's horizontal scroll", () => {
    const { container } = render(<MacroChartSection fitOverview samples={samples} oppSamples={samples} leaks={[]} gameLengthSec={300} />);
    const row = screen.getByRole("group", { name: "Chart metrics" });
    const first = within(row).getByRole("button", { name: /^Army$/ });
    const last = within(row).getByRole("button", { name: /^All$/ });
    Object.defineProperties(row, { clientWidth: { value: 100 }, clientLeft: { value: 1 } });
    vi.spyOn(row, "getBoundingClientRect").mockReturnValue(new DOMRect(10, 10, 102, 50));
    vi.spyOn(last, "getBoundingClientRect").mockImplementation(() => new DOMRect(130 - row.scrollLeft, 10, 40, 44));
    vi.spyOn(first, "getBoundingClientRect").mockImplementation(() => new DOMRect(11 - row.scrollLeft, 10, 40, 44));
    container.scrollTop = 47;
    fireEvent.focus(last);
    expect(row.scrollLeft).toBeGreaterThan(0);
    expect(last.getBoundingClientRect().right).toBeLessThanOrEqual(111);
    fireEvent.focus(first);
    expect(row.scrollLeft).toBe(0);
    expect(container.scrollTop).toBe(47);
    expect(scroll).not.toHaveBeenCalled();
  });

  it("retains native focus behavior in the normal full-game metric layout", () => {
    render(<MacroChartSection samples={samples} oppSamples={samples} leaks={[]} gameLengthSec={300} />);
    const row = screen.getByRole("group", { name: "Chart metrics" });
    const last = within(row).getByRole("button", { name: /^All$/ });
    Object.defineProperty(row, "clientWidth", { value: 100 });
    vi.spyOn(row, "getBoundingClientRect").mockReturnValue(new DOMRect(10, 10, 100, 50));
    vi.spyOn(last, "getBoundingClientRect").mockReturnValue(new DOMRect(130, 10, 40, 44));
    fireEvent.focus(last);
    expect(row.scrollLeft).toBe(0);
  });
});
