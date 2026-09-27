import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { MechanicsPanel } from "../MechanicsPanel";
import type { MacroBreakdownData } from "@/components/analyzer/macro/MacroBreakdownPanel.types";
import type { GameSummary } from "../types";

/**
 * The replay analysis page's APM row. Only uploads from agent 0.17.2+
 * carry the slim ``apm``; older breakdowns may still hold a
 * misattributed player_stats APM that must never be shown.
 */

function breakdown(meApm: number, oppApm: number): MacroBreakdownData {
  return {
    race: "Protoss",
    macro_score: 72,
    raw: { sq: 84 },
    player_stats: { me: { apm: meApm }, opponent: { apm: oppApm } },
  } as unknown as MacroBreakdownData;
}

function game(apm: number | null): GameSummary {
  return { gameId: "g", myRace: "Protoss", result: "Victory", apm } as unknown as GameSummary;
}

afterEach(cleanup);

describe("MechanicsPanel APM", () => {
  it("shows your average APM and your opponent's", () => {
    render(<MechanicsPanel breakdown={breakdown(189.7, 280.5)} game={game(189.7)} />);
    const row = screen.getByTestId("apm-stat");
    expect(row.textContent).toContain("190");
    expect(row.textContent).toContain("Opponent 281");
  });

  it("never shows an older upload's misattributed APM", () => {
    // Pre-0.17.2: slim apm is null while player_stats carries swapped values.
    render(<MechanicsPanel breakdown={breakdown(92, 0)} game={game(null)} />);
    const row = screen.getByTestId("apm-stat");
    expect(row.textContent).toContain("—");
    expect(row.textContent).not.toContain("92");
    expect(row.textContent).toContain("Not measured for this game");
  });

  it("shows your APM alone when the opponent's is missing", () => {
    const data = breakdown(189.7, 0);
    render(<MechanicsPanel breakdown={data} game={game(189.7)} />);
    const row = screen.getByTestId("apm-stat");
    expect(row.textContent).toContain("190");
    expect(row.textContent).not.toContain("Opponent");
  });
});
