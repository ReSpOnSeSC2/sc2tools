import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { AllGamesTable } from "../AllGamesTable";

const useApiMock = vi.fn();

vi.mock("@/lib/clientApi", () => ({
  useApi: (...args: unknown[]) => useApiMock(...args),
}));

vi.mock("@/components/analyzer/charts/BuildOrderDualTimeline", () => ({
  BuildOrderDualTimeline: () => <div>Build order timeline</div>,
}));

vi.mock("@/components/analyzer/macro/MacroBreakdownPanel", () => ({
  MacroBreakdownPanel: () => null,
}));

afterEach(() => {
  cleanup();
  useApiMock.mockReset();
});

describe("AllGamesTable game analysis entry point", () => {
  it("labels the destination and keeps its link separate from row expansion", () => {
    useApiMock.mockReturnValue({ data: undefined, isLoading: true, error: null });
    const { container } = render(
      <AllGamesTable
        games={[
          {
            id: "game/42",
            date: "2026-07-10T12:00:00.000Z",
            result: "Win",
            map: "Ancient Cistern",
            opp_race: "Zerg",
            opp_strategy: "Roach timing",
            my_build: "Oracle opener",
            game_length: 720,
            macro_score: 81,
          },
        ]}
      />,
    );

    const mapImages = Array.from(
      container.querySelectorAll('[data-map-artwork="image"] img'),
    );
    expect(mapImages.length).toBeGreaterThanOrEqual(2);
    mapImages.forEach((image) => {
      expect(image.getAttribute("src")).toContain(
        "Ancient%20Cistern%20LE",
      );
    });

    expect(
      screen.getByRole("columnheader", { name: "Game analysis" }),
    ).toBeTruthy();

    const links = screen.getAllByRole("link", {
      name: /Open game analysis: timeline, mechanics, build orders, and Ghost Build/i,
    });
    expect(links).toHaveLength(2);
    links.forEach((link) => {
      expect(link.getAttribute("href")).toBe("/app/game/game%2F42");
      expect(link.textContent).toContain("Open game analysis");
    });
    expect(
      screen.getByText("Timeline · mechanics · build orders · Ghost Build"),
    ).toBeTruthy();

    links[0].addEventListener("click", (event) => event.preventDefault(), {
      once: true,
    });
    fireEvent.click(links[0]);
    expect(useApiMock).not.toHaveBeenCalled();

    const desktopRow = screen.getAllByText("Ancient Cistern")[0].closest("tr");
    expect(desktopRow).toBeTruthy();
    fireEvent.click(desktopRow!);
    expect(useApiMock).toHaveBeenCalledWith("/v1/games/game%2F42/build-order");
  });

  it("retains opponent dossier context in desktop and mobile links", () => {
    useApiMock.mockReturnValue({ data: undefined, isLoading: true, error: null });
    render(
      <AllGamesTable
        games={[
          {
            id: "game/42",
            date: "2026-07-10T12:00:00.000Z",
            result: "Win",
            map: "Ancient Cistern",
          },
        ]}
        opponentContext={{
          pulseId: "1-S2-1-42/alt",
          displayName: "Barcode Rival",
        }}
      />,
    );

    const links = screen.getAllByRole("link", { name: /Open game analysis:/i });
    expect(links).toHaveLength(2);
    links.forEach((link) => {
      expect(link.getAttribute("href")).toBe(
        "/app/game/game%2F42?opponent=1-S2-1-42%2Falt&opponentName=Barcode+Rival",
      );
    });
  });
});
