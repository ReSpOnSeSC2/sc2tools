import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render, screen, within } from "@testing-library/react";
import type { LeagueBenchmark } from "@/lib/benchmarks";
import type { MacroBreakdownData } from "../MacroBreakdownPanel.types";
import { MacroKpiRow } from "../MacroKpiRow";
import { MechanicsPanel } from "../../game/MechanicsPanel";

/**
 * With a league table for the game, the SQ label reads "pXX · League MU"
 * instead of the fixed tier cut-offs; without one it falls back.
 */

const diamond: LeagueBenchmark = {
  leagueId: 4, league: "Diamond", matchup: "PvZ", n: 400, updatedAt: "2026-11-10T00:00:00.000Z",
  metrics: { spq: { n: 400, deciles: [55, 60, 65, 70, 75, 80, 85, 90, 95] } },
};

afterEach(cleanup);

describe("SQ league tag", () => {
  it("replaces the tier on the macro breakdown's SQ tile", () => {
    const view = render(<MacroKpiRow raw={{ sq: 82 }} apm={null} apmLoading={false} league={diamond} />);
    const tile = screen.getByRole("group", { name: "Spending Quotient" });
    expect(within(tile).getByText("p64 · Diamond PvZ")).toBeTruthy();
    expect(within(tile).queryByText(/tier$/)).toBeNull();
    view.rerender(<MacroKpiRow raw={{ sq: 82 }} apm={null} apmLoading={false} />);
    expect(within(screen.getByRole("group", { name: "Spending Quotient" })).getByText("Master tier")).toBeTruthy();
  });

  it("replaces the tier hint in the game page's Mechanics panel", () => {
    const breakdown = { race: "Protoss", macro_score: 70, raw: { sq: 68 } } as unknown as MacroBreakdownData;
    const view = render(<MechanicsPanel breakdown={breakdown} league={diamond} />);
    expect(screen.getByText("p36 · Diamond PvZ")).toBeTruthy();
    view.rerender(<MechanicsPanel breakdown={{ ...breakdown, raw: { sq: 72 } } as MacroBreakdownData} league={null} />);
    expect(screen.getByText("Diamond-tier spending")).toBeTruthy();
  });
});
