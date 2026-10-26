import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { MacroChartSection } from "../MacroChartSection";
import { MacroKpiRow } from "../MacroKpiRow";
import { SpendingQuotientStat } from "../SpendingQuotientStat";
import { glossaryTerm } from "@/lib/glossary";
import type { StatsEvent } from "../MacroBreakdownPanel.types";
import { readGameApm, type ApmCurveResponse, type GameApm } from "@/lib/apm";
import realCurves from "@/lib/__tests__/fixtures/apmCurves.json";

/**
 * APM in the macro breakdown: an APM view on the Match timeline switch
 * (only when the game has a trusted curve) and an APM tile beside SQ.
 */

const useApiMock = vi.fn();
vi.mock("@/lib/clientApi", () => ({
  useApi: (...args: unknown[]) => useApiMock(...args),
}));

const samples: StatsEvent[] = [
  { time: 0, army_value: 0, food_workers: 12 },
  { time: 150, army_value: 1400, food_workers: 36 },
  { time: 300, army_value: 3000, food_workers: 48 },
];

const windows = (values: number[]) => values.map((apm, i) => ({ t: i * 30, apm, spm: null }));
const APM: GameApm = {
  windowSec: 30,
  me: { avg: 190, avgSpm: 31, samples: windows([120, 160, 180, 190, 200, 200, 190, 200, 210, 210]) },
  opp: { avg: 250, avgSpm: 48, samples: windows([150, 220, 240, 250, 260, 270, 260, 250, 250, 250]) },
};

function Section({ apm, gameId = "g1" }: { apm: GameApm | null; gameId?: string }) {
  return (
    <MacroChartSection
      gameId={gameId}
      samples={samples}
      oppSamples={samples}
      leaks={[]}
      gameLengthSec={300}
      myName="ReSpOnSe"
      oppName="Squirtuoz"
      myRace="Protoss"
      apm={apm}
    />
  );
}

function readout() {
  return screen.getByText("Game time").closest("dl") as HTMLElement;
}

/** Plot ``label`` alone: "All" on, "All" off, then that metric. */
function showOnly(label: string) {
  const all = screen.getByRole("button", { name: "All" });
  if (all.getAttribute("aria-pressed") !== "true") fireEvent.click(all);
  fireEvent.click(all);
  fireEvent.click(screen.getByRole("button", { name: label }));
}

/** The read-out's "Game average" cells, in column order (you, opponent). */
function averageCells() {
  return Array.from(readout().querySelectorAll("dd.flex-wrap")).map((el) => el.textContent);
}

beforeEach(() => {
  localStorage.removeItem("sc2tools:timeline-metrics:v1");
  useApiMock.mockReturnValue({ data: null, error: null, isLoading: false });
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
  vi.unstubAllGlobals();
  useApiMock.mockReset();
});

describe("Match timeline APM view", () => {
  it("is not offered when the game has no trusted APM", () => {
    render(<Section apm={null} />);
    expect(screen.queryByRole("button", { name: "APM" })).toBeNull();
    expect(screen.getAllByRole("button", { name: /^(Army|Workers|Supply|Income)$/ })).toHaveLength(4);
  });

  it("plots both players' APM with the leader's margin", () => {
    render(<Section apm={APM} />);
    const button = screen.getByRole("button", { name: "APM" });
    showOnly("APM");
    expect(button.getAttribute("aria-pressed")).toBe("true");
    expect(screen.getByRole("img", { name: /^Actions per minute/ })).toBeTruthy();
    // Game end: 210 for you, 250 for the opponent, who leads by 40.
    expect(readout().textContent).toContain("210");
    expect(readout().textContent).toContain("250");
    expect(readout().textContent).toContain("+40");
  });

  it("shows each player's game-average APM and SPM under the APM view only", () => {
    // The warpgate fixture replay: ReSpOnSe 189.7 APM / 28.7 SPM,
    // Squirtuoz 281.5 APM / 53.9 SPM.
    const real = readGameApm(realCurves.warpgate_adept_tracking.response as ApmCurveResponse);
    render(<Section apm={real} />);
    expect(screen.queryByText("Game average")).toBeNull(); // Army view
    showOnly("APM");
    expect(screen.getByText("Game average")).toBeTruthy();
    expect(averageCells()).toEqual(["190 APM29 SPM", "282 APM54 SPM"]);
    // Alongside other metrics the read-out is a per-metric table.
    fireEvent.click(screen.getByRole("button", { name: "Workers" }));
    expect(screen.queryByText("Game average")).toBeNull();
  });

  it("shows a dash for an average the game can't provide", () => {
    render(<Section apm={{ ...APM, opp: null, me: { ...APM.me, avgSpm: null } }} />);
    showOnly("APM");
    expect(averageCells()).toEqual(["190 APM— SPM", "— APM— SPM"]);
  });

  it("falls back to Army when the next game has no APM", () => {
    const { rerender } = render(<Section apm={APM} />);
    showOnly("APM");
    rerender(<Section apm={null} gameId="g2" />);
    expect(screen.queryByRole("button", { name: "APM" })).toBeNull();
    expect(screen.getByRole("button", { name: "Army" }).getAttribute("aria-pressed")).toBe("true");
  });
});

describe("APM tile", () => {
  const raw = { sq: 82.4, supply_blocked_seconds: 4, mineral_float_spikes: 0 };

  it("shows your average with the opponent's beneath", () => {
    render(<MacroKpiRow raw={raw} apm={APM} apmLoading={false} />);
    const tile = screen.getByRole("group", { name: "APM" });
    expect(tile.textContent).toContain("190");
    expect(tile.textContent).toContain("Opponent 250");
  });

  it("says when APM wasn't measured and links to canonical recovery advice", async () => {
    render(<MacroKpiRow raw={raw} apm={null} apmLoading={false} />);
    const tile = screen.getByRole("group", { name: "APM" });
    expect(tile.textContent).toContain("—");
    expect(tile.textContent).toContain("Not measured for this game");
    fireEvent.click(within(tile).getByRole("button", { name: "About APM" }));
    const tip = await screen.findByRole("dialog", { name: "About APM" });
    expect((await within(tip).findByRole("link", { name: "Learn more" })).getAttribute("href")).toBe("/help/glossary#apm");
    expect(glossaryTerm("apm")?.long).toMatch(/Recompute or Re-sync/);
  });

  it("stays quiet while the curve is loading", () => {
    render(<MacroKpiRow raw={raw} apm={null} apmLoading />);
    expect(screen.queryByText("Not measured for this game")).toBeNull();
  });

  it.each([
    ["Spending Quotient", "spending-quotient"], ["Supply blocked", "supply-blocked"],
    ["Float spikes", "float-spikes"], ["APM", "apm"],
  ])("opens the canonical %s definition beside its measured value", async (label, id) => {
    render(<MacroKpiRow raw={raw} apm={APM} apmLoading={false} />);
    const tile = screen.getByRole("group", { name: label });
    const trigger = within(tile).getByRole("button", { name: `About ${label}` });
    expect(trigger.closest("button")?.querySelector("button")).toBeNull();
    fireEvent.click(trigger);
    const tip = await screen.findByRole("dialog", { name: `About ${label}` });
    expect(await within(tip).findByText(glossaryTerm(id)!.short)).toBeTruthy();
    expect(within(tip).getByRole("link", { name: "Learn more" }).getAttribute("href")).toBe(`/help/glossary#${id}`);
  });

  it("keeps real numeric zeros visible and does not clamp high SQ to the macro-score range", () => {
    const view = render(<MacroKpiRow raw={{ sq: 0, supply_blocked_seconds: 0, mineral_float_spikes: 0 }} apm={null} apmLoading={false} />);
    expect(within(screen.getByRole("group", { name: "Spending Quotient" })).getByText("0.0")).toBeTruthy();
    expect(within(screen.getByRole("group", { name: "Supply blocked" })).getByText("0")).toBeTruthy();
    expect(within(screen.getByRole("group", { name: "Float spikes" })).getByText("0")).toBeTruthy();
    view.rerender(<MacroKpiRow raw={{ ...raw, sq: 123.4 }} apm={null} apmLoading={false} />);
    const sq = screen.getByRole("group", { name: "Spending Quotient" });
    expect(within(sq).getByText("123.4")).toBeTruthy();
    expect(within(sq).getByText("Pro tier")).toBeTruthy();
    expect(screen.getByText("Samples >800 minerals from 4:00")).toBeTruthy();
  });

  it.each([null, undefined, Number.NaN, Number.POSITIVE_INFINITY])("shows unavailable SQ without a tier for %s", (value) => {
    render(<SpendingQuotientStat label="Spending Quotient" termId="spending-quotient" value={value} tone="cyan" decimals={1} />);
    const tile = screen.getByRole("group", { name: "Spending Quotient" });
    expect(within(tile).getByText("—")).toBeTruthy();
    expect(within(tile).queryByText(/tier$/)).toBeNull();
  });

  it("keeps a zero trusted average unavailable instead of inventing 0 APM", () => {
    const zeroAverage = readGameApm({ v: 3, has_data: true, players: [{ is_me: true, avg_apm: 0, samples: [{ t: 0, apm: 0, spm: 0 }] }] });
    expect(zeroAverage?.me.avg).toBeNull();
    render(<MacroKpiRow raw={raw} apm={zeroAverage} apmLoading={false} />);
    const tile = screen.getByRole("group", { name: "APM" });
    expect(within(tile).getByText("—")).toBeTruthy();
    expect(within(tile).queryByText("0")).toBeNull();
  });
});
