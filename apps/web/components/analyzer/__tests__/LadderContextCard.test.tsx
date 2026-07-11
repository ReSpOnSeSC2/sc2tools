import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { LadderContextCard } from "../LadderContextCard";

const useApiMock = vi.fn();
vi.mock("@/lib/clientApi", () => ({
  useApi: (...args: unknown[]) => useApiMock(...args),
}));

// recharts' ResponsiveContainer observes its parent unconditionally;
// jsdom has no ResizeObserver.
class ResizeObserverStub {
  observe() {}
  unobserve() {}
  disconnect() {}
}
(globalThis as { ResizeObserver?: unknown }).ResizeObserver =
  (globalThis as { ResizeObserver?: unknown }).ResizeObserver ||
  ResizeObserverStub;

afterEach(() => {
  cleanup();
  useApiMock.mockReset();
});

const INTEL = {
  characterId: "111",
  region: "EU",
  current: {
    rating: 4100,
    wins: 60,
    losses: 40,
    leagueType: 5,
    tier: 2,
    region: "EU",
    season: 67,
    globalRank: 2600,
    lastPlayed: "2026-07-01T10:00:00Z",
  },
  league: { type: 5, label: "Master", tier: 2 },
  percentile: 4,
  peakRating: 4350,
  leagueMax: { type: 6, label: "Grandmaster" },
  totalGamesPlayed: 2100,
  ratingHistory: [
    { t: "2026-06-01T10:00:00Z", rating: 3900 },
    { t: "2026-07-01T10:00:00Z", rating: 4100 },
  ],
  pro: {
    nickname: "Foe",
    name: "For Example",
    country: "FI",
    earnings: 12345,
    team: "Team X",
    links: { twitch: "https://twitch.tv/foe" },
  },
  linkedCharacters: [
    {
      characterId: "222",
      name: "Smurf#456",
      region: "US",
      ratingMax: 4100,
      leagueMax: 5,
    },
  ],
  pulseProfileUrl: "https://sc2pulse.nephest.com/sc2/?type=character&id=111&m=1",
};

describe("LadderContextCard", () => {
  it("renders nothing when the character id is unresolved (intel null)", () => {
    useApiMock.mockReturnValue({ data: { intel: null }, isLoading: false });
    const { container } = render(<LadderContextCard pulseId="1-S2-1-1" />);
    expect(container.firstChild).toBeNull();
  });

  it("shows a skeleton while loading", () => {
    useApiMock.mockReturnValue({ data: undefined, isLoading: true });
    render(<LadderContextCard pulseId="1-S2-1-1" />);
    expect(screen.getByText("Ladder context")).toBeTruthy();
  });

  it("renders league, percentile, record, peak, pro identity and links", () => {
    useApiMock.mockReturnValue({ data: { intel: INTEL }, isLoading: false });
    render(<LadderContextCard pulseId="1-S2-1-1" />);

    expect(screen.getByText("Master 2")).toBeTruthy();
    expect(screen.getByText(/top 4%/)).toBeTruthy();
    expect(screen.getByText("60-40")).toBeTruthy();
    expect(screen.getByText("4350")).toBeTruthy();
    expect(screen.getByText(/Pro player: Foe/)).toBeTruthy();
    expect(screen.getByText(/Also plays as/)).toBeTruthy();
    expect(screen.getByText(/Smurf#456 \(US\)/)).toBeTruthy();

    const twitch = screen.getByRole("link", { name: /Twitch/i });
    expect(twitch.getAttribute("href")).toBe("https://twitch.tv/foe");
    const pulse = screen.getByRole("link", { name: /Full profile on SC2Pulse/i });
    expect(pulse.getAttribute("href")).toContain("id=111");

    expect(
      screen.getByLabelText(/MMR over the last 90 days, currently 4100/),
    ).toBeTruthy();
  });

  it("requests the pulse-intel endpoint for the opponent", () => {
    useApiMock.mockReturnValue({ data: { intel: null }, isLoading: false });
    render(<LadderContextCard pulseId="1-S2-1-99" />);
    expect(useApiMock).toHaveBeenCalledWith(
      "/v1/opponents/1-S2-1-99/pulse-intel",
      { revalidateOnFocus: false },
    );
  });
});
