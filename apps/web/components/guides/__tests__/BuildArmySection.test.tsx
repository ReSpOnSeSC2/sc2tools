import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it } from "vitest";
import { ARMY_CAPTION, BuildArmySection } from "@/components/guides/build/BuildArmySection";
import { fixtureShare } from "@/lib/guides/__fixtures__/cells";
import type { GuideArmy } from "@/lib/guides/types";

afterEach(cleanup);

const SAMPLES = 200;

function armyWith(games: number): GuideArmy {
  return {
    "360": {
      samples: SAMPLES,
      users: 31,
      units: [{ unit: "Oracle", presence: fixtureShare(games, SAMPLES), median: 1, games }],
    },
  };
}

describe("BuildArmySection presence", () => {
  it("never claims a unit was in 100% of games when one sample lacked it", () => {
    render(<BuildArmySection army={armyWith(SAMPLES - 1)} />);
    expect(screen.getByText("in >99% of games")).toBeTruthy();
    expect(screen.queryByText("in 100% of games")).toBeNull();
  });

  it("prints 100% only when every sample fielded the unit", () => {
    render(<BuildArmySection army={armyWith(SAMPLES)} />);
    expect(screen.getByText("in 100% of games")).toBeTruthy();
  });

  it("unifies units in late-presence order, marks absent cells and omits empty columns", () => {
    const army: GuideArmy = {
      "360": { samples: 200, users: 31, units: [{ unit: "Oracle", presence: 0.8, median: 2, games: 160 }, { unit: "Adept", presence: 0.6, median: 4, games: 120 }] },
      "480": { samples: 200, users: 31, units: [{ unit: "Stalker", presence: 0.9, median: 8, games: 180 }, { unit: "Oracle", presence: 0.5, median: 1, games: 100 }] },
    };
    render(<BuildArmySection army={army} />);
    const table = screen.getByRole("table", { name: ARMY_CAPTION });
    expect(within(table).getAllByRole("columnheader").map((node) => node.textContent)).toEqual(["Unit", "6:00", "8:00"]);
    expect(within(table).getAllByRole("rowheader").map((node) => node.textContent)).toEqual(["Stalker", "Oracle", "Adept"]);
    const first = within(table).getByRole("rowheader", { name: "Stalker" }).closest("tr")!;
    expect(within(first).getByText("not built").className).toBe("sr-only");
    expect(first.textContent).toContain("—not built");
    expect(within(first).getByText("90%")).toBeTruthy();
    expect(screen.getByText("Not enough games reach 10:00")).toBeTruthy();
    expect(screen.getByRole("tab", { name: "6:00" }).getAttribute("aria-selected")).toBe("true");
    fireEvent.click(screen.getByRole("tab", { name: "8:00" }));
    expect(screen.getByRole("tab", { name: "8:00" }).getAttribute("aria-selected")).toBe("true");
    expect(within(screen.getByRole("tabpanel")).getByRole("heading", { name: "At 8:00" })).toBeTruthy();
    const markup = renderToStaticMarkup(<BuildArmySection army={army} />);
    expect(markup).toContain("At 6:00");
    expect(markup).toContain("At 8:00");
    expect(markup).not.toContain('role="tab"');
  });

  it("orders ties by earlier presence and then name", () => {
    const units = (names: string[], presence: number) => names.map((unit) => ({ unit, presence, median: 1, games: 100 }));
    render(<BuildArmySection army={{
      "360": { samples: 200, users: 31, units: units(["Zealot", "Adept"], 0.9) },
      "480": { samples: 200, users: 31, units: units(["Stalker", "Oracle"], 0.8) },
      "600": { samples: 200, users: 31, units: units(["Zealot", "Stalker", "Oracle", "Adept"], 0.5) },
    }} />);
    expect(within(screen.getByRole("table")).getAllByRole("rowheader").map((node) => node.textContent)).toEqual(["Oracle", "Stalker", "Adept", "Zealot"]);
  });
});
