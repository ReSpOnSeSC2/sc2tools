import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

const askMock = vi.hoisted(() => vi.fn());

vi.mock("@/lib/clientApi", () => ({
  useApi: (path: string | null) => ({
    data: path?.endsWith("/macro-breakdown")
      ? { macro_score: 60, race: "Protoss", raw: {}, game_length_sec: 640 }
      : undefined,
    error: null,
    isLoading: false,
    mutate: vi.fn(),
    request: vi.fn(),
  }),
}));
vi.mock("@/components/analyzer/game/MapReplaySection", () => ({
  MapReplaySection: () => <div aria-label="Shared map playback" />,
}));
vi.mock("@/components/reviews/AskForReviewButton", () => ({
  AskForReviewButton: (props: { gameId: string; matchup: string | null; durationSec: number | null; ariaLabel?: string }) => {
    askMock(props);
    return <button type="button" aria-label={props.ariaLabel}>Ask</button>;
  },
}));

import { MacroBreakdownPanel } from "../MacroBreakdownPanel";

const META = { myRace: "Protoss", opponentRace: "Zerg", map: "Alcyone LE", result: "Loss" };

afterEach(() => {
  cleanup();
  askMock.mockClear();
  document.querySelectorAll("[data-layered]").forEach((el) => el.remove());
});

describe("MacroBreakdownPanel: Ask for a review", () => {
  it("offers it in the header for a reviewable game, with the matchup and game length", () => {
    render(<MacroBreakdownPanel open gameId="g1" onClose={vi.fn()} headerMeta={META} reviewable />);
    expect(screen.getByRole("button", { name: "Ask for a review of this game" })).toBeTruthy();
    expect(askMock).toHaveBeenLastCalledWith(expect.objectContaining({ gameId: "g1", matchup: "PvZ", durationSec: 640 }));
  });

  it("stays out of the header unless the caller says the game is reviewable", () => {
    render(<MacroBreakdownPanel open gameId="g1" onClose={vi.fn()} headerMeta={META} />);
    expect(askMock).not.toHaveBeenCalled();
  });

  it("lets a dialog layered on top keep Esc and Tab, and still closes on its own Esc", () => {
    const onClose = vi.fn();
    render(<MacroBreakdownPanel open gameId="g1" onClose={onClose} headerMeta={META} reviewable />);
    // Stand-in for the review form's modal, portalled next to the panel.
    const layered = document.createElement("div");
    layered.setAttribute("role", "dialog");
    layered.setAttribute("data-layered", "");
    layered.innerHTML = '<input aria-label="Question" /><button>Post</button>';
    document.body.appendChild(layered);
    const input = layered.querySelector("input") as HTMLInputElement;
    input.focus();

    fireEvent.keyDown(input, { key: "Tab" });
    expect(document.activeElement).toBe(input);
    fireEvent.keyDown(input, { key: "Escape" });
    expect(onClose).not.toHaveBeenCalled();

    layered.remove();
    fireEvent.keyDown(screen.getByRole("button", { name: "Close macro breakdown" }), { key: "Escape" });
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});
