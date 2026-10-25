import { afterEach, describe, expect, it, vi } from "vitest";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  within,
  waitFor,
} from "@testing-library/react";
import { BuildGamesTable } from "./BuildGamesTable";
import { useApi } from "@/lib/clientApi";
import { resultLabel } from "@/components/analyzer/game/types";
import type { BuildRecentGame } from "./types";

vi.mock("@/lib/clientApi", () => ({
  useApi: vi.fn(() => ({ data: undefined, isLoading: false, error: null })),
}));

vi.mock("./StarGhostReplayButton", () => ({ StarGhostReplayButton: () => <button type="button">Use as Ghost</button> }));

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
      screen.getByRole("heading", { name: "Recent games · 1" }),
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

  it("keeps resumed rows grouped after competitive games and replaces their fake result", () => {
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
    ).toEqual(["competitive-game", "replay-resume-game"]);

    const resumedRow = desktopRows[1] as HTMLElement;
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
      screen.getByRole("heading", { name: "Recent games · 1" }),
    ).toBeTruthy();
  });


});

describe("BuildGamesTable actions, sorting and recovery", () => {
  it.each([["Tie", "Tie"], ["draw", "Tie"], ["VICTORY", "Win"], ["Defeat", "Loss"], ["unfinished", "Unknown"], [null, "Unknown"]])("labels %s as %s", (result, expected) => {
    expect(resultLabel(result)).toBe(expected);
  });

  it("exposes a focusable native disclosure and keeps Open separate", () => {
    const { container } = render(<BuildGamesTable games={[COMPETITIVE_GAME]} />);
    const row = container.querySelector('[data-game-row-id="competitive-game"]') as HTMLElement;
    const disclosure = within(row).getByRole("button", { name: /Build order from/ });
    disclosure.focus();
    expect(document.activeElement).toBe(disclosure);
    fireEvent.click(disclosure);
    expect(disclosure.getAttribute("aria-expanded")).toBe("true");
    expect(document.getElementById(disclosure.getAttribute("aria-controls")!)).toBeTruthy();
    const open = within(row).getByRole("link", { name: "Open game vs Ladder Rival on Old Sun Temple LE" });
    expect(open.getAttribute("href")).toBe("/app/game/competitive-game");
    fireEvent.click(open);
    expect(disclosure.getAttribute("aria-expanded")).toBe("true");
  });

  it("sorts length both ways, narrows by result and race, and explains the capped list", () => {
    const games = [COMPETITIVE_GAME, { ...COMPETITIVE_GAME, gameId: "short", result: "win", opp_race: "Protoss", duration: 100 }, { ...COMPETITIVE_GAME, gameId: "tie", result: "draw", duration: 400 }];
    const { container } = render(<BuildGamesTable games={games} total={90} />);
    expect(screen.getByRole("heading", { name: "Latest 3 of 90 games" })).toBeTruthy();
    expect(screen.getByText("Older games still count in every stat above.")).toBeTruthy();
    const ids = () => [...container.querySelectorAll("tbody > tr[data-game-row-id]")].map((row) => row.getAttribute("data-game-row-id"));
    fireEvent.click(screen.getByRole("button", { name: "Length" }));
    expect(ids()).toEqual(["competitive-game", "tie", "short"]);
    fireEvent.click(screen.getByRole("button", { name: "Length" }));
    expect(ids()).toEqual(["short", "tie", "competitive-game"]);
    fireEvent.click(screen.getByRole("button", { name: "Wins 1" }));
    expect(ids()).toEqual(["short"]);
    expect(screen.getByRole("button", { name: "Wins 1" }).getAttribute("aria-pressed")).toBe("true");
    fireEvent.click(screen.getByRole("button", { name: "vs Z 2" }));
    expect(ids()).toEqual(["tie", "competitive-game"]);
    expect(container.querySelector('[data-game-row-id="tie"]')?.textContent).toContain("Tie");
    expect(screen.queryByRole("button", { name: /vs T/ })).toBeNull();
  });

  it("offers Clear for an empty filter and retries a build-order failure without leaking raw errors", async () => {
    const retry = vi.fn();
    vi.mocked(useApi).mockReturnValue({ data: undefined, isLoading: false, error: { message: "private raw failure", requestId: "req-build-order" }, mutate: retry } as never);
    const { container } = render(<BuildGamesTable games={[COMPETITIVE_GAME]} />);
    fireEvent.click(screen.getByRole("button", { name: "Wins 0" }));
    expect(screen.getByText("No games match this filter")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Clear" }));
    fireEvent.click(within(container.querySelector('[data-game-row-id="competitive-game"]') as HTMLElement).getByRole("button", { name: /^Build order from/ }));
    expect(screen.queryByText("private raw failure")).toBeNull();
    expect(screen.getAllByText("Couldn't load this game's build order.")).toHaveLength(2);
    expect(screen.getAllByText("Error ID: req-build-order")).toHaveLength(2);
    fireEvent.click(screen.getAllByRole("button", { name: "Try again" })[0]);
    await waitFor(() => expect(retry).toHaveBeenCalledOnce());
    vi.mocked(useApi).mockReturnValue({ data: undefined, isLoading: false, error: null } as never);
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
    fireEvent.click(card.querySelector('button[aria-controls]') as HTMLButtonElement);
    expect(within(card).getByText("Check-in note")).toBeTruthy();
  });
});
