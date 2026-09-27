import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { MacroChartSection } from "../MacroChartSection";
import type { StatsEvent } from "../MacroBreakdownPanel.types";

const useApiMock = vi.fn();

vi.mock("@/lib/clientApi", () => ({
  useApi: (...args: unknown[]) => useApiMock(...args),
}));

const samples: StatsEvent[] = [
  { time: 0, army_value: 0, food_workers: 12 },
  { time: 75, army_value: 725, food_workers: 24 },
  { time: 140, army_value: 1425, food_workers: 36 },
  { time: 300, army_value: 3025, food_workers: 48 },
];

function TestPage({ gameId = "first-game" }: { gameId?: string }) {
  return (
    <div data-testid="scroll-page">
      <MacroChartSection
        gameId={gameId}
        samples={samples}
        oppSamples={samples}
        leaks={[]}
        gameLengthSec={300}
      />
      <div data-testid="page-bottom">More macro details below the roster</div>
    </div>
  );
}

function chartOverlay() {
  const chart = screen.getByRole("img", { name: /Army value/ });
  const overlay = chart.querySelector<SVGRectElement>('rect[fill="transparent"]')!;
  // A 300px plot for a 300-second game makes clientX equal game time.
  vi.spyOn(overlay, "getBoundingClientRect").mockReturnValue(
    new DOMRect(0, 0, 300, 220),
  );
  return overlay;
}

function point(pointerType: string, clientX: number, clientY = 30) {
  return { pointerType, pointerId: 1, clientX, clientY, buttons: 0, pressure: 0 };
}

function tap(overlay: SVGRectElement, time: number, pointerType = "touch") {
  fireEvent.pointerDown(overlay, { ...point(pointerType, time), buttons: 1, pressure: 0.5 });
  fireEvent.pointerUp(overlay, point(pointerType, time));
  // A deliberate pointer gesture generates a browser click; canceled pans do not.
  fireEvent.click(overlay, { clientX: time, clientY: 30 });
}

function expectSelection(clock: string, army: string) {
  expect(screen.getByRole("region", { name: `You composition at ${clock}` })).toBeTruthy();
  expect(screen.getByRole("region", { name: `Opponent composition at ${clock}` })).toBeTruthy();
  const tooltip = screen.getByRole("status");
  expect(within(tooltip).getByText(clock)).toBeTruthy();
  expect(tooltip.textContent).toContain(army);
  // One marker per player on the selected metric's line.
  expect(screen.getByRole("img", { name: /Army value/ }).querySelectorAll("circle")).toHaveLength(2);
}

beforeEach(() => {
  useApiMock.mockReturnValue({ data: null, error: null, isLoading: false });
  // jsdom does not provide the browser's PointerEvent or ResizeObserver APIs.
  vi.stubGlobal("PointerEvent", class extends MouseEvent {
    readonly pointerType: string;
    readonly pointerId: number;
    readonly pressure: number;
    constructor(type: string, init: PointerEventInit = {}) {
      super(type, init);
      this.pointerType = init.pointerType ?? "mouse";
      this.pointerId = init.pointerId ?? 1;
      this.pressure = init.pressure ?? 0;
    }
  });
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
  useApiMock.mockReset();
});

describe("MacroChartSection selection", () => {
  it("retains mouse inspection after leaving and resumes hover until a point is clicked", () => {
    render(<TestPage />);
    const overlay = chartOverlay();

    fireEvent.pointerMove(overlay, point("mouse", 75));
    expectSelection("1:15", "725");
    fireEvent.pointerLeave(overlay, point("mouse", 75));
    expectSelection("1:15", "725");
    fireEvent.pointerMove(overlay, point("mouse", 140));
    expectSelection("2:20", "1,425");

    tap(overlay, 75, "mouse");
    fireEvent.pointerMove(overlay, point("mouse", 140));
    expectSelection("1:15", "725");
    tap(overlay, 140, "mouse");
    expectSelection("2:20", "1,425");
  });

  it("keeps a tapped time while scrolling beyond the roster to the bottom and back", () => {
    const view = render(<TestPage />);
    const overlay = chartOverlay();
    tap(overlay, 75);
    expectSelection("1:15", "725");

    const page = screen.getByTestId("scroll-page");
    const bottom = screen.getByTestId("page-bottom");
    fireEvent.pointerDown(bottom, { ...point("touch", 140), buttons: 1 });
    fireEvent.pointerMove(bottom, { ...point("touch", 140, 180), buttons: 1 });
    fireEvent.scroll(page, { target: { scrollTop: 10000 } });
    fireEvent.pointerUp(bottom, point("touch", 140, 180));
    fireEvent.click(bottom);
    expectSelection("1:15", "725");

    fireEvent.scroll(page, { target: { scrollTop: 0 } });
    fireEvent.pointerMove(overlay, point("mouse", 140));
    fireEvent.pointerLeave(overlay, point("mouse", 140));
    view.rerender(<TestPage />);
    expectSelection("1:15", "725");

    tap(overlay, 140);
    expectSelection("2:20", "1,425");
  });

  it("does not replace the selected time when a touch or pen gesture becomes scrolling", () => {
    render(<TestPage />);
    const overlay = chartOverlay();
    tap(overlay, 75);

    for (const pointerType of ["touch", "pen"]) {
      fireEvent.pointerDown(overlay, { ...point(pointerType, 140), buttons: 1, pressure: 0.5 });
      fireEvent.pointerMove(overlay, { ...point(pointerType, 170, 160), buttons: 1, pressure: 0.5 });
      fireEvent.pointerCancel(overlay, point(pointerType, 170, 160));
      fireEvent.scroll(screen.getByTestId("scroll-page"), { target: { scrollTop: 10000 } });
      expectSelection("1:15", "725");
    }
    expect(overlay.style.touchAction).toContain("pan-y");
  });

  it("resets the selection for a different game", () => {
    const view = render(<TestPage />);
    const overlay = chartOverlay();
    tap(overlay, 75);
    expectSelection("1:15", "725");

    view.rerender(<TestPage gameId="second-game" />);
    expect(screen.queryByRole("status")).toBeNull();
    expect(screen.getByRole("region", { name: "You composition at 5:00" })).toBeTruthy();
    expect(screen.getByText(/^Game end/)).toBeTruthy();
  });
});

describe("Match timeline tabs and read-out", () => {
  const mine: StatsEvent[] = [
    { time: 0, army_value: 0, food_workers: 12, food_used: 12, food_made: 15, minerals_collection_rate: 400, vespene_collection_rate: 0 },
    { time: 150, army_value: 1500, food_workers: 30, food_used: 50, food_made: 62, minerals_collection_rate: 900, vespene_collection_rate: 200 },
    { time: 300, army_value: 3025, food_workers: 48, food_used: 95, food_made: 110, minerals_collection_rate: 1100, vespene_collection_rate: 400 },
  ];
  const theirs: StatsEvent[] = [
    { time: 0, army_value: 0, food_workers: 12, food_used: 12, food_made: 14, minerals_collection_rate: 400, vespene_collection_rate: 0 },
    { time: 150, army_value: 1800, food_workers: 26, food_used: 48, food_made: 54, minerals_collection_rate: 800, vespene_collection_rate: 100 },
    { time: 300, army_value: 2400, food_workers: 40, food_used: 80, food_made: 94, minerals_collection_rate: 1000, vespene_collection_rate: 350 },
  ];

  function readout() {
    return screen.getByText("Game time").closest("dl")!;
  }

  function overlayOf(name: RegExp) {
    const chart = screen.getByRole("img", { name });
    const overlay = chart.querySelector<SVGRectElement>('rect[fill="transparent"]')!;
    vi.spyOn(overlay, "getBoundingClientRect").mockReturnValue(
      new DOMRect(0, 0, 300, 220),
    );
    return overlay;
  }

  it("switches the plotted metric and the read-out with the tabs", () => {
    render(
      <MacroChartSection
        gameId="tabs"
        samples={mine}
        oppSamples={theirs}
        leaks={[]}
        gameLengthSec={300}
        myName="ReSpOnSe"
        oppName="Koht"
      />,
    );
    // Before any inspection the read-out shows the end of the game.
    expect(readout().textContent).toContain("5:00");
    expect(readout().textContent).toContain("3,025");
    expect(readout().textContent).toContain("2,400");

    const workers = screen.getByRole("button", { name: "Workers" });
    fireEvent.click(workers);
    expect(workers.getAttribute("aria-pressed")).toBe("true");
    expect(screen.getByRole("img", { name: /^Workers for both players/ })).toBeTruthy();
    expect(readout().textContent).toContain("48");
    expect(readout().textContent).toContain("40");

    fireEvent.click(screen.getByRole("button", { name: "Supply" }));
    expect(readout().textContent).toContain("95/110");
    expect(readout().textContent).toContain("80/94");

    fireEvent.click(screen.getByRole("button", { name: "Collection Rate" }));
    expect(readout().textContent).toContain("1,500");
    expect(readout().textContent).toContain("1,350");

    fireEvent.click(screen.getByRole("button", { name: "Income Advantage" }));
    // You lead by 150 at the end; the lead is shown beside your number.
    expect(readout().textContent).toContain("+150");
    tap(overlayOf(/^Income advantage/), 150);
    const tooltip = screen.getByRole("status");
    expect(tooltip.textContent).toContain("2:30");
    expect(tooltip.textContent).toContain("ReSpOnSe +200");
    expect(readout().textContent).toContain("locked");
  });

  it("scrubs the locked time with a sideways touch drag", () => {
    render(<TestPage />);
    const overlay = chartOverlay();
    fireEvent.pointerDown(overlay, { ...point("touch", 75), buttons: 1, pressure: 0.5 });
    fireEvent.pointerMove(overlay, { ...point("touch", 140, 34), buttons: 1, pressure: 0.5 });
    expectSelection("2:20", "1,425");
    fireEvent.pointerUp(overlay, point("touch", 140, 34));
    expect(readout().textContent).toContain("locked");
    // A mouse passing over afterwards does not move the scrubbed lock.
    fireEvent.pointerMove(overlay, point("mouse", 75));
    expectSelection("2:20", "1,425");
  });

  it("labels supply blocks and lets them be hidden", () => {
    render(
      <MacroChartSection
        gameId="blocks"
        samples={samples}
        oppSamples={samples}
        leaks={[]}
        gameLengthSec={300}
        supplyBlockWindows={[{ start: 60, end: 90 }]}
      />,
    );
    const chart = screen.getByRole("img", { name: /Army value/ });
    expect(chart.textContent).toContain("Supply Blocked");
    const toggle = screen.getByRole("button", { name: "Supply Blocks" });
    expect(toggle.getAttribute("aria-pressed")).toBe("true");
    fireEvent.click(toggle);
    expect(toggle.getAttribute("aria-pressed")).toBe("false");
    expect(chart.textContent).not.toContain("Supply Blocked");
  });

  it("disables the Supply Blocks toggle when nobody was blocked", () => {
    render(<TestPage />);
    const toggle = screen.getByRole("button", { name: "Supply Blocks" }) as HTMLButtonElement;
    expect(toggle.disabled).toBe(true);
  });
});
