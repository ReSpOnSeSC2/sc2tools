import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
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
  // A stand-in with something to click (the real panel is portalled).
  MacroBreakdownPanel: () => (
    <div role="dialog" aria-label="Macro breakdown">
      <button type="button">Inside the macro panel</button>
    </div>
  ),
}));

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn() }),
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

describe("AllGamesTable: Ask for a review", () => {
  const GAME = {
    id: "game/77",
    date: "2026-07-10T12:00:00.000Z",
    result: "Loss",
    map: "Ancient Cistern",
    my_race: "Protoss",
    opp_race: "Zerg",
    opp_strategy: "Roach timing",
    my_build: "Oracle opener",
    game_length: 720,
    macro_score: 61,
  };

  afterEach(() => vi.unstubAllEnvs());

  it("appears on an opponent dossier's rows and opens the form without expanding the row", () => {
    vi.stubEnv("NEXT_PUBLIC_REVIEWS_ENABLED", "on");
    useApiMock.mockReturnValue({ data: undefined, isLoading: false, error: null });
    render(<AllGamesTable games={[GAME]} opponentContext={{ pulseId: "1-S2-1-7" }} />);
    const asks = screen.getAllByRole("button", { name: "Ask for a review of this game" });
    // One compact desktop action, one full-width mobile action.
    expect(asks).toHaveLength(2);
    expect(asks[0].textContent).toContain("Review");
    fireEvent.click(asks[0]);
    expect(screen.getByRole("dialog", { name: "Ask for a replay review" })).toBeTruthy();
    expect(screen.queryByText("Build order timeline")).toBeNull();
  });

  it("typing in the form never toggles the row or loses focus", async () => {
    vi.stubEnv("NEXT_PUBLIC_REVIEWS_ENABLED", "on");
    useApiMock.mockReturnValue({ data: undefined, isLoading: false, error: null });
    const props = { games: [GAME], opponentContext: { pulseId: "1-S2-1-7" } };
    const { rerender } = render(<AllGamesTable {...props} />);
    fireEvent.click(screen.getAllByRole("button", { name: "Ask for a review of this game" })[0]);
    // Let the form's own initial focus run first.
    await act(async () => { await new Promise((r) => setTimeout(r, 5)); });
    const question = screen.getByRole("textbox", { name: /question/i });
    question.focus();
    // Clicks inside the (portalled) form must not reach the clickable row.
    // ▾ marks an expanded row (desktop and mobile); it must stay collapsed
    // after every single click (two toggles would cancel out).
    fireEvent.mouseDown(question);
    fireEvent.click(question);
    expect(screen.queryByText("▾")).toBeNull();
    fireEvent.change(question, { target: { value: "Why did my blink all-in fail?" } });
    fireEvent.click(within(screen.getByRole("dialog", { name: "Ask for a replay review" })).getByRole("button", { name: "Macro" }));
    expect(screen.queryByText("▾")).toBeNull();
    question.focus();
    // A re-render of the row must not reset the form's focus.
    rerender(<AllGamesTable {...props} games={[{ ...GAME }]} />);
    await act(async () => { await new Promise((r) => setTimeout(r, 5)); });
    expect(document.activeElement).toBe(question);
    expect((question as HTMLTextAreaElement).value).toBe("Why did my blink all-in fail?");
  });

  it("clicks inside the macro breakdown never toggle the row either", () => {
    useApiMock.mockReturnValue({ data: undefined, isLoading: false, error: null });
    render(<AllGamesTable games={[GAME]} opponentContext={{ pulseId: "1-S2-1-7" }} />);
    fireEvent.click(screen.getAllByRole("button", { name: /Open macro breakdown/ })[0]);
    fireEvent.click(screen.getByRole("button", { name: "Inside the macro panel" }));
    expect(screen.queryByText("▾")).toBeNull();
  });

  it("stays out of other tables and hides while the rollout is off", () => {
    vi.stubEnv("NEXT_PUBLIC_REVIEWS_ENABLED", "on");
    useApiMock.mockReturnValue({ data: undefined, isLoading: false, error: null });
    const { unmount } = render(<AllGamesTable games={[GAME]} />);
    expect(screen.queryByRole("button", { name: "Ask for a review of this game" })).toBeNull();
    unmount();
    vi.stubEnv("NEXT_PUBLIC_REVIEWS_ENABLED", "off");
    render(<AllGamesTable games={[GAME]} opponentContext={{ pulseId: "1-S2-1-7" }} />);
    expect(screen.queryByRole("button", { name: "Ask for a review of this game" })).toBeNull();
  });
});

describe("AllGamesTable game analysis entry point", () => {
  it("keeps directory-only channel links out of desktop and mobile game rows", async () => {
    apiCallMock.mockResolvedValue({ configuredPlatforms: [], linksByGameId: {}, channelsByGameId: {
      "game/42": [{ perspective: "opponent", playerName: "Harstem", channels: { youtube: "https://www.youtube.com/@Harstem" } }],
    } });
    await act(async () => {
      render(<AllGamesTable games={[{ id: "game/42", date: "2026-07-10T12:00:00.000Z" }]} />);
    });
    expect(apiCallMock).toHaveBeenCalled();
    expect(screen.queryByRole("link", { name: "Visit Harstem's YouTube channel" })).toBeNull();
    expect(screen.queryByRole("columnheader", { name: "POV streams" })).toBeNull();
    expect(screen.queryByLabelText("Game streams")).toBeNull();
  });
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

    // The request can start before React commits the response to the table.
    expect(
      await screen.findByRole("columnheader", { name: "POV streams" }),
    ).toBeTruthy();
    const twitchLinks = screen.getAllByRole("link", {
      name: /Watch You POV on Twitch at 1:02:03 - Streamer/i,
    });
    expect(twitchLinks).toHaveLength(2);
    twitchLinks.forEach((link) => {
      expect(link.getAttribute("href")).toBe(
        "https://www.twitch.tv/videos/42?t=1h2m3s",
      );
      expect(link.className).toContain("text-[#9146ff]");
    });
    const youtubeLinks = screen.getAllByRole("link", {
      name: /Watch Opponent POV on YouTube at 2:05 - Barcode Rival/i,
    });
    expect(youtubeLinks).toHaveLength(2);
    youtubeLinks.forEach((link) => {
      expect(link.getAttribute("href")).toBe(
        "https://youtu.be/AbCdEf12345?t=125s",
      );
      expect(link.getAttribute("title")).toBe(
        "Watch Opponent POV on YouTube at 2:05 - Barcode Rival",
      );
      expect(link.className).toContain("text-[#ff0000]");
      expect(link.className).toContain("hover:bg-[#ff0000]/15");
      expect(link.className).toContain("focus-visible:ring-[#ff0000]");
      expect(link.className).not.toContain("text-[#9146ff]");
      expect(link.querySelector("svg.lucide-youtube")).toBeTruthy();
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
