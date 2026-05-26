import { afterEach, describe, expect, it, vi } from "vitest";
import {
  cleanup,
  fireEvent,
  render,
  screen,
} from "@testing-library/react";
import { AutoCandidateCard } from "../AutoCandidateCard";
import type { AutoCandidate } from "../types";

afterEach(cleanup);

function makeCandidate(over: Partial<AutoCandidate> = {}): AutoCandidate {
  return {
    matchup: "PvZ",
    perspective: "you",
    proposedName: "PvZ - Stargate Phoenix Discovery",
    proposedSlug: "pvz-stargate-phoenix-discovery",
    race: "Protoss",
    vsRace: "Zerg",
    rules: [
      { type: "before", name: "BuildStargate", time_lt: 210 },
      { type: "count_max", name: "TrainPhoenix", time_lt: 300, count: 2 },
    ],
    gameCount: 7,
    winRate: 0.71,
    cohesion: 0.84,
    selfMatchRate: 0.91,
    sampleGames: [
      {
        gameId: "g1",
        map: "Equilibrium",
        result: "win",
        date: "2026-05-01T00:00:00Z",
      },
      {
        gameId: "g2",
        map: "Hard Lead",
        result: "loss",
        date: "2026-04-20T00:00:00Z",
      },
    ],
    ...over,
  };
}

describe("AutoCandidateCard", () => {
  it("renders the proposed name, matchup, and matched-count", () => {
    render(
      <AutoCandidateCard
        candidate={makeCandidate()}
        onCreate={() => {}}
        onDismiss={() => {}}
      />,
    );
    expect(
      screen.getByRole("heading", {
        name: /PvZ - Stargate Phoenix Discovery/i,
      }),
    ).toBeTruthy();
    expect(screen.getByText(/matched 7 games/i)).toBeTruthy();
    expect(screen.getByText("PvZ")).toBeTruthy();
  });

  it("shows the cohesion meter with its rounded percent", () => {
    render(
      <AutoCandidateCard
        candidate={makeCandidate({ cohesion: 0.847 })}
        onCreate={() => {}}
        onDismiss={() => {}}
      />,
    );
    const meter = screen.getByRole("meter", { name: /Group cohesion 85%/i });
    expect(meter.getAttribute("aria-valuenow")).toBe("85");
  });

  it("renders the W/L pill for each sample replay", () => {
    render(
      <AutoCandidateCard
        candidate={makeCandidate()}
        onCreate={() => {}}
        onDismiss={() => {}}
      />,
    );
    // Two sample games; the win/loss pills carry aria-labels Win/Loss.
    expect(screen.getByLabelText("Win")).toBeTruthy();
    expect(screen.getByLabelText("Loss")).toBeTruthy();
    expect(screen.getByText(/Equilibrium/)).toBeTruthy();
    expect(screen.getByText(/Hard Lead/)).toBeTruthy();
  });

  it("renames inline and emits the edited name to onCreate", () => {
    const onCreate = vi.fn();
    render(
      <AutoCandidateCard
        candidate={makeCandidate()}
        onCreate={onCreate}
        onDismiss={() => {}}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: /Rename candidate/i }));
    const input = screen.getByLabelText(
      /Edit build name/i,
    ) as HTMLInputElement;
    expect(input).toBeTruthy();
    fireEvent.change(input, { target: { value: "My PvZ Phoenix" } });
    fireEvent.click(screen.getByRole("button", { name: /Confirm name/i }));
    expect(
      screen.getByRole("heading", { name: /My PvZ Phoenix/i }),
    ).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: /Create build/i }));
    expect(onCreate).toHaveBeenCalledTimes(1);
    const [emittedCandidate, emittedName] = onCreate.mock.calls[0];
    expect(emittedName).toBe("My PvZ Phoenix");
    expect(emittedCandidate.proposedSlug).toBe(
      "pvz-stargate-phoenix-discovery",
    );
  });

  it("cancelling the rename restores the prior saved name", () => {
    render(
      <AutoCandidateCard
        candidate={makeCandidate()}
        onCreate={() => {}}
        onDismiss={() => {}}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: /Rename candidate/i }));
    const input = screen.getByLabelText(
      /Edit build name/i,
    ) as HTMLInputElement;
    fireEvent.change(input, { target: { value: "should-not-stick" } });
    fireEvent.click(screen.getByRole("button", { name: /Cancel rename/i }));
    expect(
      screen.getByRole("heading", {
        name: /PvZ - Stargate Phoenix Discovery/i,
      }),
    ).toBeTruthy();
  });

  it("dismiss button calls onDismiss with the candidate", () => {
    const onDismiss = vi.fn();
    const c = makeCandidate();
    render(
      <AutoCandidateCard
        candidate={c}
        onCreate={() => {}}
        onDismiss={onDismiss}
      />,
    );
    fireEvent.click(
      screen.getByRole("button", {
        name: /Dismiss PvZ - Stargate Phoenix Discovery/i,
      }),
    );
    expect(onDismiss).toHaveBeenCalledTimes(1);
    expect(onDismiss.mock.calls[0][0]).toBe(c);
  });

  it("every interactive control meets the ≥44px touch-target rule", () => {
    render(
      <AutoCandidateCard
        candidate={makeCandidate()}
        onCreate={() => {}}
        onDismiss={() => {}}
      />,
    );
    const dismiss = screen.getByRole("button", {
      name: /Dismiss /i,
    });
    expect(dismiss.className).toMatch(/h-11/);
    expect(dismiss.className).toMatch(/w-11/);
    const rename = screen.getByRole("button", { name: /Rename candidate/i });
    expect(rename.className).toMatch(/h-11/);
    const create = screen.getByRole("button", { name: /Create build/i });
    // Create is the primary action — size="lg" → h-12 (48px) so the
    // tap target comfortably exceeds the 44px floor.
    expect(create.className).toMatch(/h-12/);
  });
});
