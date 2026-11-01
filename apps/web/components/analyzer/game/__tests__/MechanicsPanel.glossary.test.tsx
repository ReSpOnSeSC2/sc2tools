import { afterEach, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import type { MacroBreakdownData } from "@/components/analyzer/macro/MacroBreakdownPanel.types";
import type { GameSummary } from "../types";

const h = vi.hoisted(() => ({ lookups: vi.fn() }));
vi.mock("@/lib/glossary", async importOriginal => {
  const actual = await importOriginal<typeof import("@/lib/glossary")>();
  return { ...actual, glossaryTerm: (id: string) => { h.lookups(id); return actual.glossaryTerm(id); } };
});

import { MechanicsPanel } from "../MechanicsPanel";

/**
 * Each mechanics label carries its glossary InfoTip inside its ``dt``.
 * Definitions load only when a tip opens, and a value the definition does
 * not describe (an older supply total built from window spans) keeps its
 * plain label.
 */

function zergBreakdown(raw: Record<string, unknown> = {}): MacroBreakdownData {
  return {
    race: "Zerg",
    macro_score: 72,
    raw: {
      sq: 81,
      injects_actual: 10,
      injects_expected: 12,
      supply_block_windows: [{ start: 300, end: 312, blocked_sec: 8 }],
      creep_tumors_total: 5,
      creep_tumors_queen: 3,
      creep_tumors_spread: 2,
      mineral_float_spikes: 0,
      ...raw,
    },
  } as unknown as MacroBreakdownData;
}

const game = { apm: 190 } as GameSummary;
const TIPS = [
  "About Macro score",
  "About SQ (Spending Quotient)",
  "About APM",
  "About Supply blocked",
  "About Inject Efficiency",
  "About Creep tumors",
  "About Float spikes",
];

afterEach(() => { cleanup(); h.lookups.mockClear(); });

it("gives every mechanics label a tip inside its term and loads a definition only when opened", async () => {
  render(<MechanicsPanel breakdown={zergBreakdown()} game={game} />);
  const panel = within(screen.getByTestId("mechanics-panel"));
  for (const name of TIPS) expect(panel.getByRole("button", { name }).closest("dt")).not.toBeNull();
  expect(h.lookups).not.toHaveBeenCalled();
  expect(panel.getByText("APM").hasAttribute("title")).toBe(false);

  fireEvent.click(panel.getByRole("button", { name: "About Inject Efficiency" }));
  const tip = await screen.findByRole("dialog", { name: "About Inject Efficiency" });
  expect(await within(tip).findByText("Recorded race-mechanic casts compared with an uptime-based estimate.")).toBeTruthy();
  expect(h.lookups).toHaveBeenCalledWith("mechanic-efficiency");
  expect(within(tip).getByRole("link", { name: "Learn more" }).getAttribute("href")).toBe("/help/glossary#mechanic-efficiency");
});

it("names the race mechanic's tip after the race's own label", () => {
  render(<MechanicsPanel breakdown={{ race: "Terran", raw: { mules_actual: 7, mules_expected: 9 } } as unknown as MacroBreakdownData} />);
  expect(screen.getByRole("button", { name: "About MULE Efficiency" })).toBeTruthy();
});

it("keeps the supply tip off a total added up from older window spans", () => {
  render(<MechanicsPanel breakdown={zergBreakdown({ supply_block_windows: [{ start: 300, end: 312 }, { start: 400, end: 404, blocked_sec: 3 }] })} game={game} />);
  const panel = within(screen.getByTestId("mechanics-panel"));
  expect(panel.getByText("15s")).toBeTruthy();
  expect(panel.queryByRole("button", { name: "About Supply blocked" })).toBeNull();
  expect(panel.getByText("Supply blocked").tagName).toBe("DT");
});

it("keeps the supply tip for credited window seconds, the engine's scalar and a missing value", () => {
  const { unmount } = render(<MechanicsPanel breakdown={zergBreakdown({ supply_block_windows: undefined, supply_blocked_seconds: 9.4 })} game={game} />);
  expect(screen.getByText("9s")).toBeTruthy();
  expect(screen.getByRole("button", { name: "About Supply blocked" })).toBeTruthy();
  unmount();
  render(<MechanicsPanel breakdown={zergBreakdown({ supply_block_windows: undefined })} game={game} />);
  expect(screen.getByRole("button", { name: "About Supply blocked" })).toBeTruthy();
});

it("describes float spikes by the measured rule, without claiming the bank stayed spent", () => {
  const { unmount } = render(<MechanicsPanel breakdown={zergBreakdown()} game={game} />);
  const label = screen.getByText("Float spikes");
  expect(label.tagName).toBe("DT");
  expect(label.nextElementSibling?.textContent).toBe("No float spikes recorded.");
  unmount();
  render(<MechanicsPanel breakdown={zergBreakdown({ mineral_float_spikes: 3 })} game={game} />);
  expect(screen.getByText("Float spikes").nextElementSibling?.textContent).toBe("3 samples with more than 800 minerals banked from 4:00.");
  cleanup();
  render(<MechanicsPanel breakdown={zergBreakdown({ mineral_float_spikes: 1 })} game={game} />);
  expect(screen.getByText("Float spikes").nextElementSibling?.textContent).toBe("1 sample with more than 800 minerals banked from 4:00.");
});
