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
  expect(screen.getByRole("img", { name: /Army value/ }).querySelectorAll("circle")).toHaveLength(4);
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
