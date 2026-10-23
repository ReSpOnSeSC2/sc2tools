/**
 * The "3 of last 5" sample lines on the opponent scouting widgets.
 * The cloud now derives favourite opening and cheese from real games
 * and sends how many games each number comes from; the cards show it
 * so viewers can tell a two-game read from a twenty-game habit.
 */

import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render } from "@testing-library/react";
import type { LiveGameEnvelope, LiveGamePayload } from "@/components/overlay/types";
import { CheeseWidget, FavOpeningWidget } from "../PrePostFlow";
import { ScoutingWidget } from "../ScoutingWidget";

afterEach(cleanup);

const BASE: LiveGamePayload = { myRace: "Protoss", oppRace: "Zerg", matchup: "PvZ" };

describe("FavOpeningWidget", () => {
  it("says how many recent games showed the opening", () => {
    const { container } = render(
      <FavOpeningWidget
        live={{ ...BASE, favOpening: { name: "Zerg - 12 Pool", share: 0.6, samples: 3, of: 5 } }}
      />,
    );
    expect(container.textContent).toContain("Zerg - 12 Pool");
    expect(container.textContent).toContain("60%");
    expect(container.textContent).toContain("3 of last 5 games");
  });

  it("keeps the sample count for payloads cached before the window existed", () => {
    const { container } = render(
      <FavOpeningWidget live={{ ...BASE, favOpening: { name: "Pool first", share: 0.55, samples: 11 } }} />,
    );
    expect(container.textContent).toContain("11 samples");
    expect(container.textContent).not.toContain("of last");
  });
});

describe("CheeseWidget", () => {
  it("shows the cheesy games behind the percentage", () => {
    const { container } = render(
      <CheeseWidget live={{ ...BASE, cheeseProbability: 0.5, cheeseHistory: { samples: 2, of: 4 } }} />,
    );
    expect(container.textContent).toContain("50%");
    expect(container.textContent).toContain("scout the natural early");
    expect(container.textContent).toContain("2 of last 4 games");
  });

  it("omits the sample line when the alert comes from the game just played", () => {
    const { container } = render(<CheeseWidget live={{ ...BASE, cheeseProbability: 0.7 }} />);
    expect(container.textContent).toContain("70%");
    expect(container.textContent).not.toContain("of last");
  });

  it("stays hidden below the 40% alert", () => {
    const { container } = render(
      <CheeseWidget live={{ ...BASE, cheeseProbability: 0.3, cheeseHistory: { samples: 1, of: 3 } }} />,
    );
    expect(container.textContent).toBe("");
  });
});

describe("ScoutingWidget cheese row", () => {
  it("adds the game count to the pre-game cheese warning", () => {
    const env: LiveGameEnvelope = {
      type: "liveGameState",
      phase: "match_started",
      capturedAt: 0,
      opponent: { name: "Future", race: "Zerg" },
      streamerHistory: {
        oppName: "Future",
        oppRace: "Zerg",
        headToHead: { wins: 1, losses: 3 },
        cheeseProbability: 0.75,
        cheeseHistory: { samples: 3, of: 4 },
      },
    };
    const { container } = render(<ScoutingWidget live={null} liveGame={env} />);
    expect(container.textContent).toContain("75% likely");
    expect(container.textContent).toContain("3 of last 4 games");
  });
});
