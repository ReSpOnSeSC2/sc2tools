import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { ToastProvider } from "@/components/ui/Toast";
import { SeasonRecap } from "../SeasonRecap";
import type { ArcadeGame } from "../types";

const useArcadeDataMock = vi.fn();
vi.mock("../hooks/useArcadeData", () => ({
  useArcadeData: () => useArcadeDataMock(),
}));

afterEach(() => {
  cleanup();
  useArcadeDataMock.mockReset();
});

function recentGames(n: number): ArcadeGame[] {
  const now = Date.now();
  return Array.from({ length: n }, (_, i) => ({
    gameId: `g${i}`,
    date: new Date(now - i * 3_600_000).toISOString(),
    result: i % 2 === 0 ? "Victory" : "Defeat",
    myMmr: 4000 + i,
    myBuild: "PvZ - 2 Stargate Void Ray",
    oppRace: "Z",
    map: "Alcyone",
    oppPulseId: `p${i % 3}`,
    opponent: { displayName: `Foe${i % 3}` },
  })) as ArcadeGame[];
}

function renderCard() {
  return render(
    <ToastProvider>
      <SeasonRecap />
    </ToastProvider>,
  );
}

describe("SeasonRecap", () => {
  it("shows the unlock prompt below 10 games", () => {
    useArcadeDataMock.mockReturnValue({
      data: { games: recentGames(4) },
      loading: false,
    });
    renderCard();
    expect(screen.getByText(/unlocks at 10 games/i)).toBeTruthy();
    expect(screen.queryByRole("button", { name: /open my recap/i })).toBeNull();
  });

  it("shows a skeleton while loading with no data yet", () => {
    useArcadeDataMock.mockReturnValue({ data: null, loading: true });
    renderCard();
    // Title still renders; no CTA yet.
    expect(screen.getByText("Season Recap")).toBeTruthy();
    expect(screen.queryByRole("button", { name: /open my recap/i })).toBeNull();
  });

  it("offers the recap and opens the slide modal at >= 10 games", () => {
    useArcadeDataMock.mockReturnValue({
      data: { games: recentGames(14) },
      loading: false,
    });
    renderCard();
    const open = screen.getByRole("button", { name: /open my recap/i });
    fireEvent.click(open);

    // Modal opens on the intro slide with slide navigation present.
    expect(screen.getByText(/your season, wrapped/i)).toBeTruthy();
    expect(screen.getByRole("tablist", { name: /recap slides/i })).toBeTruthy();

    // Advancing reaches the totals slide.
    fireEvent.click(screen.getByRole("button", { name: /next/i }));
    expect(screen.getByText(/games played/i)).toBeTruthy();
  });
});
