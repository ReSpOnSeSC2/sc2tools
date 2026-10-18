import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";

import type { OfflineMacroChartProps } from "@/lib/instant/reportGameDetail";
import { OfflineMacroChart } from "../report/OfflineMacroChart";

const fetchSpy = vi.fn();
const samples = [
  { time: 0, army_value: 0, food_workers: 12 },
  { time: 300, army_value: 1500, food_workers: 36 },
];
const props: OfflineMacroChartProps = {
  samples,
  oppSamples: samples,
  gameLengthSec: 300,
  leaks: [],
  buildOrder: { ok: true, events: [], opp_events: [] },
  casualtyEvents: [
    { time: 75.25, owner: "opp", killer: "me", category: "workers", name: "Drone" },
    { time: 120, owner: "me", killer: "opp", category: "units", name: "Zealot" },
    { time: 200, owner: "opp", killer: "me", category: "buildings", name: "Hatchery" },
  ],
};

beforeEach(() => {
  vi.stubGlobal("fetch", fetchSpy);
  vi.stubGlobal("ResizeObserver", class {
    constructor(private callback: ResizeObserverCallback) {}
    observe(target: Element) {
      this.callback(
        [{ target, contentRect: new DOMRect(0, 0, 600, 220) }] as ResizeObserverEntry[],
        this as unknown as ResizeObserver,
      );
    }
    disconnect() {}
  });
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  fetchSpy.mockReset();
});

function metric(name: string) {
  return within(screen.getByRole("group", { name: "Chart metrics" })).getByRole("button", { name });
}

function counts(clock: string, category: string) {
  const table = screen.getByRole("table", { name: `Kills and losses at ${clock}` });
  const row = within(table).getByRole("row", { name: new RegExp(`^${category}\\b`) });
  return within(row).getAllByRole("cell").map((cell) => cell.textContent);
}

describe("OfflineMacroChart casualties", () => {
  it("shows exact selected-time deaths between stats samples without fetching", () => {
    render(<OfflineMacroChart {...props} />);
    expect(counts("5:00", "Workers")).toEqual(["1", "0", "0", "1"]);
    expect(counts("5:00", "Units")).toEqual(["0", "1", "1", "0"]);

    const readout = screen.getByText("Game time").closest("dl")!;
    const heading = screen.getByRole("heading", { name: "Killed & lost" });
    expect(readout.compareDocumentPosition(heading) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();

    const overlay = screen.getByRole("img", { name: /Army value/ }).querySelector<SVGRectElement>('rect[fill="transparent"]')!;
    vi.spyOn(overlay, "getBoundingClientRect").mockReturnValue(new DOMRect(0, 0, 300, 220));
    fireEvent.click(overlay, { clientX: 75.2, clientY: 30 });
    expect(counts("1:15", "Workers")).toEqual(["0", "0", "0", "0"]);
    fireEvent.click(overlay, { clientX: 75.25, clientY: 30 });
    expect(counts("1:15", "Workers")).toEqual(["1", "0", "0", "1"]);
    expect(counts("1:15", "Units")).toEqual(["0", "0", "0", "0"]);
    expect(counts("1:15", "Buildings")).toEqual(["0", "0", "0", "0"]);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("narrows to workers and preserves army filters while other metrics are selected", () => {
    render(<OfflineMacroChart {...props} />);
    fireEvent.click(screen.getByRole("button", { name: "Show Buildings" }));
    fireEvent.click(metric("Workers"));
    fireEvent.click(metric("Army"));
    expect(counts("5:00", "Workers")).toEqual(["1", "0", "0", "1"]);
    expect(screen.queryByRole("group", { name: "Casualty categories" })).toBeNull();
    const table = screen.getByRole("table", { name: "Kills and losses at 5:00" });
    expect(within(table).queryByRole("row", { name: /^Units\b/ })).toBeNull();

    fireEvent.click(metric("Supply"));
    fireEvent.click(metric("Workers"));
    expect(screen.queryByRole("heading", { name: "Killed & lost" })).toBeNull();
    fireEvent.click(metric("Army"));
    expect(screen.getByRole("button", { name: "Show Buildings" }).getAttribute("aria-pressed")).toBe("false");
    expect(counts("5:00", "Units")).toEqual(["0", "1", "1", "0"]);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("shows unavailable local details without offering an online reanalysis action", () => {
    render(<OfflineMacroChart {...props} casualtyEvents={undefined} />);
    expect(screen.getByText("Kill and loss details are unavailable for this replay. Re-analyze it to add them.")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Re-analyze replay" })).toBeNull();
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});
