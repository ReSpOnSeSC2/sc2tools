import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { MechanicsPanel } from "../MechanicsPanel";
import type { MacroBreakdownData } from "@/components/analyzer/macro/MacroBreakdownPanel.types";

/**
 * Creep tumor row — Zerg-only, engine 1.5.6+ payloads. The row must
 * hide entirely on payloads that predate creep tracking (key absent)
 * rather than claiming a zero it never measured.
 */

function zergBreakdown(
  raw: Record<string, unknown>,
): MacroBreakdownData {
  return {
    race: "Zerg",
    macro_score: 70,
    raw: {
      sq: 80,
      injects_actual: 10,
      injects_expected: 12,
      ...raw,
    },
  } as unknown as MacroBreakdownData;
}

afterEach(cleanup);

describe("MechanicsPanel creep tumor stat", () => {
  it("renders queen/spread split, first-plant clock, and losses", () => {
    render(
      <MechanicsPanel
        breakdown={zergBreakdown({
          creep_tumors_queen: 8,
          creep_tumors_spread: 4,
          creep_tumors_total: 12,
          creep_tumors_lost: 3,
          first_tumor_sec: 161,
        })}
      />,
    );
    const stat = screen.getByTestId("creep-tumor-stat");
    expect(stat.textContent).toContain("12");
    expect(stat.textContent).toContain("8 queen / 4 spread");
    expect(stat.textContent).toContain("first at 2:41");
    expect(stat.textContent).toContain("3 lost");
  });

  it("renders an explicit zero when tracked but none planted", () => {
    render(
      <MechanicsPanel
        breakdown={zergBreakdown({
          creep_tumors_queen: 0,
          creep_tumors_spread: 0,
          creep_tumors_total: 0,
          creep_tumors_lost: 0,
          first_tumor_sec: null,
        })}
      />,
    );
    expect(
      screen.getByTestId("creep-tumor-stat").textContent,
    ).toContain("none planted");
  });

  it("hides the row on payloads without creep fields", () => {
    render(<MechanicsPanel breakdown={zergBreakdown({})} />);
    expect(screen.queryByTestId("creep-tumor-stat")).toBeNull();
  });

  it("omits the losses segment when nothing died", () => {
    render(
      <MechanicsPanel
        breakdown={zergBreakdown({
          creep_tumors_queen: 2,
          creep_tumors_spread: 0,
          creep_tumors_total: 2,
          creep_tumors_lost: 0,
          first_tumor_sec: 90,
        })}
      />,
    );
    expect(
      screen.getByTestId("creep-tumor-stat").textContent,
    ).not.toContain("lost");
  });
});
