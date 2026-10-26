import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { MacroChartSection } from "../MacroChartSection";
import type { CasualtyEvent, StatsEvent } from "../MacroBreakdownPanel.types";
import { timelineMetric } from "../timelineMetrics";

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

/** A tap that starts and ends on ``target`` without travelling. */
function tapOn(target: Element, pointerType = "touch") {
  fireEvent.pointerDown(target, { ...point(pointerType, 40, 40), buttons: 1, pressure: 0.5 });
  fireEvent.pointerUp(target, point(pointerType, 42, 41));
  fireEvent.click(target, { clientX: 42, clientY: 41 });
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
  localStorage.removeItem("sc2tools:timeline-metrics:v1");
  localStorage.removeItem("sc2tools:timeline-bank-view:v1");
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

  it("closes the card on a tap off the chart but keeps the inspected moment", () => {
    render(<TestPage />);
    const overlay = chartOverlay();
    tap(overlay, 75);
    expectSelection("1:15", "725");

    tapOn(screen.getByTestId("page-bottom"));
    expect(screen.queryByRole("status")).toBeNull();
    // The crosshair, its markers, the read-out and the roster stay at 1:15,
    // released from the lock.
    expect(screen.getByRole("region", { name: "You composition at 1:15" })).toBeTruthy();
    expect(screen.getByRole("img", { name: /Army value/ }).querySelectorAll("circle")).toHaveLength(2);
    expect(screen.getByText("Game time").closest("dl")!.textContent).toContain("1:15");
    expect(screen.queryByText("locked")).toBeNull();

    // A mouse passing over the chart previews again, card and all.
    fireEvent.pointerMove(overlay, point("mouse", 140));
    expectSelection("2:20", "1,425");
    tapOn(screen.getByTestId("page-bottom"), "mouse");
    expect(screen.queryByRole("status")).toBeNull();
    // A tap on the chart brings it back, locked.
    tap(overlay, 75);
    expectSelection("1:15", "725");
    expect(screen.getByText("locked")).toBeTruthy();
  });

  it("keeps the card through taps on the chart's own controls and drags off it", () => {
    render(
      <div>
        <MacroChartSection
          gameId="controls"
          samples={samples}
          oppSamples={samples}
          leaks={[]}
          gameLengthSec={300}
          supplyBlockWindows={[{ start: 60, end: 90 }]}
        />
        <div data-testid="page-bottom">Below</div>
      </div>,
    );
    const overlay = chartOverlay();
    tap(overlay, 75);
    expectSelection("1:15", "725");

    tapOn(screen.getByRole("switch", { name: "Show supply blocks" }));
    tapOn(screen.getByRole("button", { name: "Supply" }));
    tapOn(screen.getByText("Game time"));
    expect(screen.getByRole("status").textContent).toContain("1:15");

    // Pressing off the chart and dragging (a text selection, a pan that
    // the browser did not cancel) is not a tap.
    const bottom = screen.getByTestId("page-bottom");
    fireEvent.pointerDown(bottom, { ...point("mouse", 10, 10), buttons: 1 });
    fireEvent.pointerUp(bottom, point("mouse", 10, 90));
    expect(screen.getByRole("status").textContent).toContain("1:15");
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

  function renderTabs() {
    return render(
      <div>
        <MacroChartSection
          gameId="tabs"
          samples={mine}
          oppSamples={theirs}
          leaks={[]}
          gameLengthSec={300}
          myName="ReSpOnSe"
          oppName="Koht"
          myRace="Protoss"
        />
        <div data-testid="page-bottom">Below</div>
      </div>,
    );
  }

  const pressed = (name: string) =>
    screen.getByRole("button", { name }).getAttribute("aria-pressed");

  it("plots one metric at a time and shows who leads on it", () => {
    renderTabs();
    // Before any inspection the read-out shows the end of the game, with
    // your 625 army-value lead beside your number.
    expect(readout().textContent).toContain("5:00");
    expect(readout().textContent).toContain("3,025");
    expect(readout().textContent).toContain("2,400");
    expect(readout().textContent).toContain("+625");
    expect(screen.getByRole("group", { name: "Chart metrics" })).toBeTruthy();
    expect(pressed("Army")).toBe("true");
    expect(pressed("All")).toBe("false");

    // Workers joins Army; turning Army off leaves Workers alone.
    fireEvent.click(screen.getByRole("button", { name: "Workers" }));
    fireEvent.click(screen.getByRole("button", { name: "Army" }));
    expect(pressed("Workers")).toBe("true");
    expect(pressed("Army")).toBe("false");
    expect(screen.getByRole("img", { name: /^Workers for both players/ })).toBeTruthy();
    expect(readout().textContent).toContain("48");
    expect(readout().textContent).toContain("40");

    fireEvent.click(screen.getByRole("button", { name: "Supply" }));
    fireEvent.click(screen.getByRole("button", { name: "Workers" }));
    expect(readout().textContent).toContain("95/110");
    expect(readout().textContent).toContain("80/94");

    fireEvent.click(screen.getByRole("button", { name: "Income" }));
    fireEvent.click(screen.getByRole("button", { name: "Supply" }));
    expect(readout().textContent).toContain("1,500");
    expect(readout().textContent).toContain("1,350");
    expect(readout().textContent).toContain("+150");
    tap(overlayOf(/^Income/), 150);
    const tooltip = screen.getByRole("status");
    expect(tooltip.textContent).toContain("2:30");
    expect(tooltip.textContent).toContain("ReSpOnSe ahead by 200");
    expect(readout().textContent).toContain("locked");
  });

  it("overlays several metrics, each indexed to its peak and keyed by line pattern", () => {
    renderTabs();
    fireEvent.click(screen.getByRole("button", { name: "Workers" }));
    expect(pressed("Army")).toBe("true");
    expect(pressed("Workers")).toBe("true");

    const chart = screen.getByRole("img", {
      name: /^Army value and Workers for both players over game time, each as a share of its game peak/,
    });
    // One axis: share of each metric's game peak.
    expect(chart.textContent).toContain("Peak");
    expect(chart.textContent).toContain("50%");
    // Four lines: army solid, workers dashed, in each player's colour.
    const lines = Array.from(chart.querySelectorAll("path[fill='none']"));
    expect(lines).toHaveLength(4);
    const workersDash = timelineMetric("workers").dash;
    expect(workersDash).toBeTruthy();
    expect(lines.filter((l) => l.getAttribute("stroke-dasharray") === workersDash)).toHaveLength(2);
    expect(lines.filter((l) => !l.hasAttribute("stroke-dasharray"))).toHaveLength(2);
    // The lit segments carry the legend: their line pattern.
    const group = screen.getByRole("group", { name: "Chart metrics" });
    expect(within(group).getByRole("button", { name: "Workers" }).querySelector("line")).toBeTruthy();

    tap(overlayOf(/^Army value and Workers/), 150);
    expect(chart.querySelectorAll("circle")).toHaveLength(4);
    const card = screen.getByRole("status");
    const rows = within(card).getAllByRole("row").slice(1);
    expect(rows.map((r) => r.textContent)).toEqual([
      "Army1,5001,800 (ahead)+300",
      "Workers30 (ahead)26+4",
    ]);
    // The leader on each row is underlined in their colour.
    expect(within(rows[0]).getByText("1,800").className).toContain("decoration-player-opp");
    expect(within(rows[1]).getByText("30").className).toContain("decoration-player-you");

    // Below the chart, one column per metric.
    const table = screen.getByRole("table", { name: /^Army value, Workers for both players at 2:30/ });
    expect(within(table).getByRole("row", { name: /ReSpOnSe/ }).textContent).toContain("1,500");
    expect(within(table).getByRole("row", { name: /Koht/ }).textContent).toContain("26");
  });

  it("turns every metric on or off with All", () => {
    renderTabs();
    const all = screen.getByRole("button", { name: "All" });
    fireEvent.click(all);
    expect(all.getAttribute("aria-pressed")).toBe("true");
    for (const name of ["Army", "Workers", "Supply", "Income", "Bank"]) expect(pressed(name)).toBe("true");
    expect(
      screen.getByRole("img", { name: /^Army value, Workers, Supply used, Income .* and Unspent minerals and gas/ }),
    ).toBeTruthy();

    fireEvent.click(all);
    for (const name of ["Army", "Workers", "Supply", "Income", "Bank", "All"]) expect(pressed(name)).toBe("false");
    const chart = screen.getByRole("img", { name: /no metric selected/ });
    expect(chart.querySelectorAll("path[fill='none']")).toHaveLength(0);
    expect(screen.getByText("Pick a metric above to plot it")).toBeTruthy();
    expect(screen.getByText("No metric selected")).toBeTruthy();
    // Inspecting still moves the roster; there is just no card to show.
    tap(overlayOf(/no metric selected/), 150);
    expect(screen.queryByRole("status")).toBeNull();
    expect(screen.getByRole("region", { name: "ReSpOnSe composition at 2:30" })).toBeTruthy();
  });

  it("compares Total, Minerals and Gas without moving the inspected time or seeking from view controls", () => {
    const seek = vi.fn();
    const bankSamples = [{ time: 0, minerals_current: 100, vespene_current: 50 }, { time: 150, minerals_current: 600, vespene_current: 200 }, { time: 300, minerals_current: 900, vespene_current: 400 }];
    const opponentBank = [{ time: 0, minerals_current: 80, vespene_current: 20 }, { time: 150, minerals_current: 200, vespene_current: 300 }, { time: 300, minerals_current: 500, vespene_current: 100 }];
    render(<MacroChartSection gameId="bank-views" samples={bankSamples} oppSamples={opponentBank} leaks={[]} gameLengthSec={300} onSeek={seek} />);
    fireEvent.click(screen.getByRole("button", { name: "Bank", exact: true }));
    fireEvent.click(screen.getByRole("button", { name: "Army", exact: true }));
    const resources = screen.getByRole("group", { name: "Bank resource" });
    expect(within(resources).getByRole("button", { name: "Total", exact: true }).getAttribute("aria-pressed")).toBe("true");
    tap(overlayOf(/^Unspent minerals and gas/), 150);
    expect(seek).toHaveBeenCalledTimes(1); expect(seek).toHaveBeenCalledWith(150); seek.mockClear();
    const breakdown = screen.getByRole("group", { name: "Selected-time bank breakdown" });
    expect(within(breakdown).getByRole("region", { name: "You bank breakdown" }).textContent).toBe("YouTotal800Minerals600Gas200");
    expect(within(breakdown).getByRole("region", { name: "Opponent bank breakdown" }).textContent).toBe("OpponentTotal500Minerals200Gas300");
    const card = within(screen.getByRole("status"));
    expect(card.getByRole("row", { name: /Bank total/ }).textContent).toContain("800");
    expect(card.getByRole("row", { name: /Minerals/ }).textContent).toContain("600");
    expect(card.getByRole("row", { name: /Gas/ }).textContent).toContain("200");

    fireEvent.click(within(resources).getByRole("button", { name: "Gas", exact: true }));
    expect(screen.getByRole("img", { name: /^Unspent gas for both players/ })).toBeTruthy();
    expect(readout().textContent).toContain("2:30"); expect(readout().textContent).toContain("200"); expect(readout().textContent).toContain("300");
    expect(within(screen.getByRole("status")).getByRole("row", { name: /Gas/ }).textContent).toContain("300 (ahead)");
    expect(screen.getByRole("region", { name: "You composition at 2:30" })).toBeTruthy();
    fireEvent.click(within(resources).getByRole("button", { name: "Minerals", exact: true }));
    expect(screen.getByRole("img", { name: /^Unspent minerals for both players/ })).toBeTruthy();
    expect(readout().textContent).toContain("600"); expect(readout().textContent).toContain("+400");
    expect(seek).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Workers", exact: true }));
    expect(screen.getByRole("img", { name: /^Workers and Unspent minerals/ })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Bank", exact: true }).getAttribute("aria-pressed")).toBe("true");
    expect(within(resources).getByRole("button", { name: "Minerals", exact: true }).getAttribute("aria-pressed")).toBe("true");
  });

  it("shows known zero and a missing resource honestly in both selected-time and hover breakdowns", () => {
    localStorage.setItem("sc2tools:timeline-metrics:v1", '["bank"]');
    render(<MacroChartSection samples={[{ time: 0, minerals_current: 0, vespene_current: 0 }, { time: 30, minerals_current: 450 }]} oppSamples={[]} leaks={[]} gameLengthSec={30} inspectionTime={0} />);
    let breakdown = screen.getByRole("group", { name: "Selected-time bank breakdown" });
    expect(within(breakdown).getByRole("region", { name: "You bank breakdown" }).textContent).toBe("YouTotal0Minerals0Gas0");
    expect(within(breakdown).getByRole("region", { name: "Opponent bank breakdown" }).textContent).toBe("OpponentTotal—Minerals—Gas—");
    // The fixture's 300px plot spans this 30-second game: its right edge is 0:30.
    tap(overlayOf(/^Unspent minerals and gas/), 300);
    breakdown = screen.getByRole("group", { name: "Selected-time bank breakdown" });
    expect(within(breakdown).getByRole("region", { name: "You bank breakdown" }).textContent).toBe("YouTotal—Minerals450Gas—");
    const card = within(screen.getByRole("status"));
    expect(within(card.getByRole("row", { name: /Bank total/ })).getAllByRole("cell").map((cell) => cell.textContent)).toEqual(["—", "—", "—"]);
    expect(card.getByRole("row", { name: /Minerals/ }).textContent).toContain("450");
    expect(within(card.getByRole("row", { name: /Gas/ })).getAllByRole("cell").map((cell) => cell.textContent)).toEqual(["—", "—", "—"]);
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
    const toggle = screen.getByRole("switch", { name: "Show supply blocks" });
    expect(toggle.getAttribute("aria-checked")).toBe("true");
    fireEvent.click(toggle);
    expect(toggle.getAttribute("aria-checked")).toBe("false");
    expect(chart.textContent).not.toContain("Supply Blocked");
  });

  it("offers no supply-block switch when nobody was blocked", () => {
    render(<TestPage />);
    expect(screen.queryByRole("switch")).toBeNull();
  });
});

describe("Match timeline kills and losses", () => {
  const deaths: CasualtyEvent[] = [
    { time: 75, owner: "opp", killer: "me", category: "units", name: "Marine" },
    { time: 140, owner: "me", killer: "opp", category: "workers", name: "Probe" },
    { time: 200, owner: "opp", killer: "me", category: "buildings", name: "Barracks" },
  ];

  function renderCasualties() {
    return render(
      <MacroChartSection
        gameId="casualties"
        samples={samples}
        oppSamples={samples}
        leaks={[]}
        gameLengthSec={300}
        casualtyEvents={deaths}
      />,
    );
  }

  function casualtyTable(clock: string) {
    return screen.getByRole("table", { name: `Kills and losses at ${clock}` });
  }

  function counts(clock: string, category: string) {
    const row = within(casualtyTable(clock)).getByRole("row", { name: new RegExp(`^${category}\\b`) });
    return within(row).getAllByRole("cell").map((cell) => cell.textContent);
  }

  function metric(name: string) {
    return within(screen.getByRole("group", { name: "Chart metrics" })).getByRole("button", { name });
  }

  it("places kills and losses after army value and follows the chart's selected time", () => {
    renderCasualties();
    expect(counts("5:00", "Units")).toEqual(["1", "0", "0", "1"]);
    expect(counts("5:00", "Workers")).toEqual(["0", "1", "1", "0"]);
    expect(counts("5:00", "Buildings")).toEqual(["1", "0", "0", "1"]);
    expect(counts("5:00", "Minerals")).toEqual(["200", "50", "50", "200"]);
    expect(counts("5:00", "Gas")).toEqual(["0", "0", "0", "0"]);
    expect(counts("5:00", "Total")).toEqual(["200", "50", "50", "200"]);

    const readout = screen.getByText("Game time").closest("dl")!;
    const heading = screen.getByRole("heading", { name: "Killed & lost" });
    expect(readout.compareDocumentPosition(heading) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();

    const overlay = chartOverlay();
    tap(overlay, 75);
    expect(counts("1:15", "Units")).toEqual(["1", "0", "0", "1"]);
    expect(counts("1:15", "Workers")).toEqual(["0", "0", "0", "0"]);
    expect(counts("1:15", "Buildings")).toEqual(["0", "0", "0", "0"]);
    expect(counts("1:15", "Minerals")).toEqual(["50", "0", "0", "50"]);
    expect(counts("1:15", "Total")).toEqual(["50", "0", "0", "50"]);
    tap(overlay, 140);
    expect(counts("2:20", "Workers")).toEqual(["0", "1", "1", "0"]);
    expect(counts("2:20", "Buildings")).toEqual(["0", "0", "0", "0"]);
    expect(counts("2:20", "Minerals")).toEqual(["50", "50", "50", "50"]);
    expect(counts("2:20", "Total")).toEqual(["50", "50", "50", "50"]);
  });

  it("switches to worker losses without forgetting the army category filters", () => {
    renderCasualties();
    const filters = screen.getByRole("group", { name: "Casualty categories" });
    fireEvent.click(within(filters).getByRole("button", { name: "Show Buildings" }));
    fireEvent.click(within(filters).getByRole("button", { name: "Show Workers" }));

    fireEvent.click(metric("Workers"));
    fireEvent.click(metric("Army"));
    expect(screen.queryByRole("group", { name: "Casualty categories" })).toBeNull();
    expect(counts("5:00", "Workers")).toEqual(["0", "1", "1", "0"]);
    expect(counts("5:00", "Minerals")).toEqual(["0", "50", "50", "0"]);
    expect(counts("5:00", "Gas")).toEqual(["0", "0", "0", "0"]);
    expect(counts("5:00", "Total")).toEqual(["0", "50", "50", "0"]);
    expect(within(casualtyTable("5:00")).queryByRole("row", { name: /^Units\b/ })).toBeNull();
    expect(within(casualtyTable("5:00")).queryByRole("row", { name: /^Buildings\b/ })).toBeNull();

    fireEvent.click(metric("Army"));
    const restored = screen.getByRole("group", { name: "Casualty categories" });
    expect(within(restored).getByRole("button", { name: "Show Units" }).getAttribute("aria-pressed")).toBe("true");
    expect(within(restored).getByRole("button", { name: "Show Buildings" }).getAttribute("aria-pressed")).toBe("false");
    expect(within(restored).getByRole("button", { name: "Show Workers" }).getAttribute("aria-pressed")).toBe("false");
    expect(counts("5:00", "Units")).toEqual(["1", "0", "0", "1"]);
    expect(counts("5:00", "Minerals")).toEqual(["50", "0", "0", "50"]);
    expect(counts("5:00", "Total")).toEqual(["50", "0", "0", "50"]);
  });

  it("passes the game's patch era into mineral, gas and combined casualty totals", () => {
    const pricedDeaths: CasualtyEvent[] = [
      { time: 75.25, owner: "opp", killer: "me", category: "units", name: "Queen" },
      { time: 200, owner: "me", killer: "opp", category: "buildings", name: "Factory" },
    ];
    const chart = (patchEra: "before" | "after") => (
      <MacroChartSection
        gameId="casualty-costs"
        samples={samples}
        oppSamples={samples}
        leaks={[]}
        gameLengthSec={300}
        casualtyEvents={pricedDeaths}
        patchEra={patchEra}
      />
    );
    const view = render(chart("before"));
    expect(counts("5:00", "Minerals")).toEqual(["150", "150", "150", "150"]);
    expect(counts("5:00", "Gas")).toEqual(["0", "100", "100", "0"]);
    expect(counts("5:00", "Total")).toEqual(["150", "250", "250", "150"]);

    view.rerender(chart("after"));
    expect(counts("5:00", "Minerals")).toEqual(["175", "150", "150", "175"]);
    expect(counts("5:00", "Gas")).toEqual(["0", "100", "100", "0"]);
    expect(counts("5:00", "Total")).toEqual(["175", "250", "250", "175"]);

    const overlay = chartOverlay();
    tap(overlay, 75.2);
    expect(counts("1:15", "Total")).toEqual(["0", "0", "0", "0"]);
    tap(overlay, 75.25);
    expect(counts("1:15", "Minerals")).toEqual(["175", "0", "0", "175"]);
    expect(counts("1:15", "Gas")).toEqual(["0", "0", "0", "0"]);
    expect(counts("1:15", "Total")).toEqual(["175", "0", "0", "175"]);
  });

  it("hides the section when neither Army nor Workers is selected", () => {
    renderCasualties();
    fireEvent.click(metric("Supply"));
    fireEvent.click(metric("Army"));
    expect(screen.queryByRole("heading", { name: "Killed & lost" })).toBeNull();

    fireEvent.click(metric("Workers"));
    expect(counts("5:00", "Workers")).toEqual(["0", "1", "1", "0"]);
    expect(within(casualtyTable("5:00")).queryByRole("row", { name: /^Units\b/ })).toBeNull();
  });
});
