import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { BuildArmySection } from "@/components/guides/build/BuildArmySection";
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
});
