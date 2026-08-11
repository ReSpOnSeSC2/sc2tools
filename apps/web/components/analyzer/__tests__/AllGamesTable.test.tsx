import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { AllGamesTable } from "../AllGamesTable";

const useApiMock = vi.fn();
const apiCallMock = vi.fn();
const getTokenMock = vi.fn(async () => "test-token");

vi.mock("@clerk/nextjs", () => ({
  useAuth: () => ({
    getToken: getTokenMock,
    isLoaded: true,
    isSignedIn: true,
  }),
}));

vi.mock("@/lib/clientApi", () => ({
  useApi: (...args: unknown[]) => useApiMock(...args),
  apiCall: (...args: unknown[]) => apiCallMock(...args),
}));

vi.mock("@/components/analyzer/charts/BuildOrderDualTimeline", () => ({
  BuildOrderDualTimeline: () => <div>Build order timeline</div>,
}));

vi.mock("@/components/analyzer/macro/MacroBreakdownPanel", () => ({
  MacroBreakdownPanel: () => null,
}));

beforeEach(() => {
  useApiMock.mockReturnValue({
    data: undefined,
    isLoading: true,
    error: null,
  });
  apiCallMock.mockResolvedValue({
    configuredPlatforms: [],
    linksByGameId: {},
  });
});

afterEach(() => {
  cleanup();
  useApiMock.mockReset();
  apiCallMock.mockReset();
  getTokenMock.mockClear();
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
      screen.getByRole("columnheader", { name: "Actions" }),
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
    const desktopMapLabel = screen.getAllByText("Ancient Cistern")[0]
      .parentElement as HTMLElement;
    const scrollRegion = desktopMapLabel.closest(".overflow-x-auto");
    vi.spyOn(desktopMapLabel, "getBoundingClientRect").mockReturnValue({
      left: 400,
      top: 300,
      width: 160,
      height: 24,
      x: 400,
      y: 300,
      right: 560,
      bottom: 324,
      toJSON: () => ({}),
    } as DOMRect);
    expect(scrollRegion).toBeTruthy();
    expect(desktopMapLabel.getAttribute("title")).toBeNull();

    fireEvent.mouseEnter(desktopMapLabel);
    const preview = document.body.querySelector("[data-map-preview]");
    expect(preview).toBeTruthy();
    expect(container.contains(preview)).toBe(false);
    expect(scrollRegion?.contains(preview)).toBe(false);

    fireEvent.keyDown(document, { key: "Escape" });
    expect(document.body.querySelector("[data-map-preview]")).toBeNull();
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
            replayAvailable: true,
            replayFilename: "Ancient Cistern vs Barcode Rival.SC2Replay",
            replaySizeBytes: 128_000,
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
    expect(
      screen.getAllByRole("button", { name: "Download replay" }),
    ).toHaveLength(2);
  });

  it("loads visible games in one request and renders timestamped POV controls", async () => {
    apiCallMock.mockResolvedValue({
      configuredPlatforms: ["twitch", "youtube"],
      linksByGameId: {
        "game/42": [
          {
            platform: "twitch",
            perspective: "me",
            playerName: "Streamer",
            url: "https://www.twitch.tv/videos/42",
            offsetSec: 3723,
          },
          {
            platform: "youtube",
            perspective: "opponent",
            playerName: "Barcode Rival",
            url: "https://youtu.be/AbCdEf12345",
            offsetSec: 125,
          },
        ],
      },
    });

    const { container } = render(
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

    await waitFor(() => {
      expect(apiCallMock).toHaveBeenCalledWith(
        getTokenMock,
        "/v1/games/vod-links",
        {
          method: "POST",
          body: JSON.stringify({
            gameIds: ["game/42"],
            includeOpponent: true,
          }),
        },
      );
    });

    expect(
      screen.getByRole("columnheader", { name: "POV streams" }),
    ).toBeTruthy();
    const twitchLinks = screen.getAllByRole("link", {
      name: /Watch You POV on Twitch at 1:02:03 - Streamer/i,
    });
    expect(twitchLinks).toHaveLength(2);
    twitchLinks.forEach((link) => {
      expect(link.getAttribute("href")).toBe(
        "https://www.twitch.tv/videos/42?t=1h2m3s",
      );
    });
    const youtubeLinks = screen.getAllByRole("link", {
      name: /Watch Opponent POV on YouTube at 2:05 - Barcode Rival/i,
    });
    expect(youtubeLinks).toHaveLength(2);
    youtubeLinks.forEach((link) => {
      expect(link.getAttribute("href")).toBe(
        "https://youtu.be/AbCdEf12345?t=125s",
      );
    });
    expect(screen.getAllByText("You")).toHaveLength(2);
    expect(screen.getAllByText("Opp")).toHaveLength(2);

    const desktopRow = container.querySelector(
      'tr[data-game-row-id="game/42"]',
    );
    expect(desktopRow).toBeTruthy();
    fireEvent.click(desktopRow!);
    expect(container.querySelector('tbody td[colspan="11"]')).toBeTruthy();
  });

  it("falls back to the visible date range without adding an empty column", async () => {
    apiCallMock
      .mockRejectedValueOnce(
        Object.assign(new Error("POST route not deployed"), { status: 404 }),
      )
      .mockResolvedValueOnce({
        configuredPlatforms: ["twitch"],
        linksByGameId: {},
      });

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
        opponentContext={{ pulseId: "1-S2-1-42/alt" }}
      />,
    );

    await waitFor(() => {
      expect(apiCallMock).toHaveBeenNthCalledWith(
        2,
        getTokenMock,
        "/v1/games/vod-links?since=2026-07-10T12%3A00%3A00.000Z&until=2026-07-10T12%3A00%3A00.000Z&includeOpponent=1&oppPulseId=1-S2-1-42%2Falt",
      );
    });
    expect(
      screen.queryByRole("columnheader", { name: "POV streams" }),
    ).toBeNull();
  });

  it("handles reserved-property game ids before enrichment arrives", () => {
    useApiMock.mockReturnValue({ data: undefined, isLoading: false, error: null });
    apiCallMock.mockImplementation(() => new Promise(() => {}));

    render(
      <AllGamesTable
        games={[
          {
            id: "constructor",
            date: "2026-07-10T12:00:00.000Z",
            result: "Win",
            map: "Ancient Cistern",
          },
        ]}
      />,
    );

    expect(
      screen.queryByRole("columnheader", { name: "POV streams" }),
    ).toBeNull();
    expect(screen.getAllByRole("link", { name: /Open game analysis:/i }))
      .toHaveLength(2);
  });
});
