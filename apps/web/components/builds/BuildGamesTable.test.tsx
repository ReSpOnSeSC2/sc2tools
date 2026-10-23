import { afterEach, describe, expect, it, vi } from "vitest";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  within,
} from "@testing-library/react";
import { BuildGamesTable } from "./BuildGamesTable";
import type { BuildRecentGame } from "./types";

vi.mock("@/lib/clientApi", () => ({
  useApi: vi.fn(() => ({ data: undefined, isLoading: false, error: null })),
}));

vi.mock("@/components/maps/MapArtwork", () => ({
  MapLabel: ({ name }: { name?: string | null }) => <span>{name}</span>,
}));

vi.mock("@/components/analyzer/charts/BuildOrderTimeline", () => ({
  BuildOrderTimeline: () => null,
}));

const COMPETITIVE_GAME: BuildRecentGame = {
  gameId: "competitive-game",
  date: "2026-08-08T14:14:12.000Z",
  map: "Old Sun Temple LE",
  opponent: "Ladder Rival",
  opp_race: "Zerg",
  opp_strategy: "3 Hatch Before Pool",
  result: "loss",
  duration: 640,
  macroScore: 85,
};

const RESUMED_GAME: BuildRecentGame = {
  gameId: "replay-resume-game",
  date: "2026-08-09T15:57:19.000Z",
  map: "Old Sun Temple LE",
  opponent: "Replay Zulrah",
  opp_race: "Zerg",
  opp_strategy: "3 Hatch Before Pool",
  result: "win",
  duration: 460,
  macroScore: 85,
  isResumedFromReplay: true,
};

afterEach(cleanup);

describe("BuildGamesTable replay-resume tests", () => {
  it("hides replay-resume rows by default and explains that they do not count", () => {
    const { container } = render(
      <BuildGamesTable
        games={[COMPETITIVE_GAME]}
        resumedGames={[RESUMED_GAME]}
        resumedCount={1}
      />,
    );

    expect(
      screen.getByRole("heading", { name: "Recent games · 1 counted" }),
    ).toBeTruthy();
    expect(
      screen.getByText("1 replay-resume test is excluded from all statistics."),
    ).toBeTruthy();

    const toggle = screen.getByRole("switch", {
      name: "Show replay-resume tests",
    });
    expect(toggle.getAttribute("aria-checked")).toBe("false");
    expect(
      container.querySelector('[data-game-row-id="competitive-game"]'),
    ).toBeTruthy();
    expect(
      container.querySelector('[data-game-row-id="replay-resume-game"]'),
    ).toBeNull();
    expect(screen.queryByText("Replay Zulrah")).toBeNull();
  });

  it("merges resumed rows newest-first and replaces their fake result on desktop and mobile", () => {
    const { container } = render(
      <BuildGamesTable
        games={[COMPETITIVE_GAME]}
        resumedGames={[RESUMED_GAME]}
        resumedCount={1}
      />,
    );

    fireEvent.click(
      screen.getByRole("switch", { name: "Show replay-resume tests" }),
    );

    const desktopRows = Array.from(
      container.querySelectorAll("tbody > tr[data-game-row-id]"),
    );
    expect(
      desktopRows.map((row) => row.getAttribute("data-game-row-id")),
    ).toEqual(["replay-resume-game", "competitive-game"]);

    const resumedRow = desktopRows[0] as HTMLElement;
    expect(within(resumedRow).getByText("Replay resume")).toBeTruthy();
    expect(within(resumedRow).queryByText("Win")).toBeNull();
    expect(
      within(resumedRow).getByLabelText(
        "Replay resume test; excluded from all statistics",
      ),
    ).toBeTruthy();

    const resumedCard = container.querySelector(
      '[data-game-card-id="replay-resume-game"]',
    ) as HTMLElement;
    expect(resumedCard).toBeTruthy();
    expect(within(resumedCard).getByText("Replay resume")).toBeTruthy();
    expect(within(resumedCard).queryByText("Win")).toBeNull();
    expect(
      screen.getByRole("heading", { name: "Recent games · 1 counted" }),
    ).toBeTruthy();
  });


});

describe("BuildGamesTable check-in markers", () => {
  const PLANNED_GAME: BuildRecentGame = {
    ...COMPETITIVE_GAME,
    gameId: "planned-game",
    result: "win",
    planned: {
      detected: "PvZ - Macro Transition (Unclassified)",
      notes: "Got scouted, so I skipped the third and held.",
    },
  };

  it("marks planned games and shows their notes when expanded", () => {
    const { container } = render(
      <BuildGamesTable games={[PLANNED_GAME, COMPETITIVE_GAME]} />,
    );
    const row = container.querySelector(
      '[data-game-row-id="planned-game"]',
    ) as HTMLElement;
    const badge = within(row).getByTestId("planned-badge");
    expect(badge.getAttribute("title")).toBe(
      "Replay classified as PvZ - Macro Transition (Unclassified)",
    );
    expect(within(row).getByText("Has a check-in note")).toBeTruthy();
    const plain = container.querySelector(
      '[data-game-row-id="competitive-game"]',
    ) as HTMLElement;
    expect(within(plain).queryByTestId("planned-badge")).toBeNull();

    expect(screen.queryAllByText(/skipped the third/)).toHaveLength(0);
    fireEvent.click(row);
    // Desktop row and mobile card share the expanded state.
    expect(screen.getAllByText("Check-in note")).toHaveLength(2);
    expect(screen.getAllByText(/skipped the third/)).toHaveLength(2);
  });

  it("marks planned games on the mobile cards too", () => {
    const { container } = render(<BuildGamesTable games={[PLANNED_GAME]} />);
    const card = container.querySelector(
      '[data-game-card-id="planned-game"]',
    ) as HTMLElement;
    expect(within(card).getByTestId("planned-badge")).toBeTruthy();
    fireEvent.click(within(card).getByRole("button"));
    expect(within(card).getByText("Check-in note")).toBeTruthy();
  });
});
