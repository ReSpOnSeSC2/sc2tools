import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { TrendsDataProvider } from "@/lib/trendsDataContext";
import { ActivityCalendarChart } from "../ActivityCalendarChart";
import { GameLengthWrChart } from "../GameLengthWrChart";
import { MapTrendChart } from "../MapTrendChart";
import { MatchupGameLengthCard } from "../MatchupGameLengthCard";
import { MatchupOverTimeChart } from "../MatchupOverTimeChart";
import { MmrProgressionChart } from "../MmrProgressionChart";
import { MomentumChart } from "../MomentumChart";
import { NetMmrByMatchupChart } from "../NetMmrByMatchupChart";
import { NetMmrRaceOpponentsModal } from "../NetMmrRaceOpponentsModal";
import { OppMmrBucketGamesModal } from "../OppMmrBucketGamesModal";
import { OppMmrBucketsChart } from "../OppMmrBucketsChart";
import { TimeOfDayHeatmap } from "../TimeOfDayHeatmap";

const useApiMock = vi.fn();
const personalNameMock = vi.fn();
vi.mock("@/lib/clientApi", () => ({ useApi: (...args: unknown[]) => useApiMock(...args) }));
vi.mock("@/lib/useMyDisplayName", () => ({ useMyDisplayName: () => personalNameMock() }));
vi.mock("../../AllGamesTable", () => ({ AllGamesTable: () => <div>Personal game controls</div> }));
vi.mock("@/components/maps/MapArtwork", () => ({ MapArtwork: () => null }));
vi.mock("@/components/maps/MapPreviewDialog", () => ({ MapPreviewDialog: () => null }));
vi.mock("@/lib/filterContext", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/filterContext")>();
  return { ...actual, useFilters: () => ({ filters: { race: "P", map: "Gold Base", mmr_min: 3000, min_minutes: 6 }, dbRev: 4 }) };
});

const cohort = { excluded_players: ["1-S2-1-123"], excluded_races: ["Z"], player_mmr_min: 4000, include_unrated: false };
const band = { lo: 4500, hi: 5000, wins: 1, losses: 1, total: 2 };

beforeEach(() => { useApiMock.mockReturnValue({ data: undefined, isLoading: false, error: undefined }); });
afterEach(() => { cleanup(); useApiMock.mockReset(); personalNameMock.mockReset(); });

describe("global trends chart integration", () => {
  it("routes every chart and both drilldowns through the same filtered admin scope", () => {
    render(<TrendsDataProvider mode="global" cohort={cohort}>
      <ActivityCalendarChart /><GameLengthWrChart /><MapTrendChart bucket="week" />
      <MatchupGameLengthCard /><MatchupOverTimeChart bucket="week" /><MmrProgressionChart bucket="week" />
      <MomentumChart /><NetMmrByMatchupChart /><OppMmrBucketsChart /><TimeOfDayHeatmap />
      <NetMmrRaceOpponentsModal race="T" onClose={() => {}} />
      <OppMmrBucketGamesModal band={band} onClose={() => {}} />
    </TrendsDataProvider>);
    const requests = useApiMock.mock.calls.map(([path]) => path).filter(Boolean) as string[];
    const expected = ["activity-calendar", "length-buckets", "timeseries/maps", "timeseries/matchups", "timeseries/mmr", "mmr-by-matchup", "momentum", "opp-mmr-buckets", "timeseries/day-hour", "mmr-by-matchup/opponents", "opp-mmr-buckets/games"];
    expect(new Set(requests.map((path) => new URL(path, "https://example.test").pathname))).toEqual(new Set(expected.map((path) => `/v1/admin/global-trends/${path}`)));
    for (const path of requests) {
      const url = new URL(path, "https://example.test");
      expect(url.searchParams.get("excluded_players")).toBe("1-S2-1-123");
      expect(url.searchParams.get("excluded_races")).toBe("Z");
      expect(url.searchParams.get("player_mmr_min")).toBe("4000");
      expect(url.searchParams.get("include_unrated")).toBe("false");
      expect(url.searchParams.get("race")).toBe("P");
      expect(url.searchParams.get("map")).toBe("Gold Base");
      expect(url.searchParams.get("mmr_min")).toBe("3000");
      expect(url.searchParams.get("min_minutes")).toBe("6");
      expect(url.hash).toBe("#4");
    }
    expect(personalNameMock).not.toHaveBeenCalled();
  });

  it("shows the owning player in global game drilldowns without personal replay actions", () => {
    useApiMock.mockReturnValue({ data: { total: 1, games: [{ id: "game-1", playerId: "2-S2-1-456", playerName: "Player Two", date: "2026-08-24T12:00:00Z", result: "Win", opponent: "Opponent", opp_mmr: 4700, map: "Gold Base", game_length: 600 }] }, isLoading: false });
    render(<TrendsDataProvider mode="global" cohort={cohort}><OppMmrBucketGamesModal band={band} onClose={() => {}} /></TrendsDataProvider>);
    expect(screen.getByRole("table", { name: "Player game records in MMR band" })).toBeTruthy();
    expect(screen.getByText("Player Two")).toBeTruthy();
    expect(screen.queryByText("Personal game controls")).toBeNull();
    expect(screen.queryAllByRole("link")).toHaveLength(0);
    expect(personalNameMock).not.toHaveBeenCalled();
  });

  it("distinguishes request failures from empty cohorts and offers retry", async () => {
    const retry = vi.fn();
    useApiMock.mockReturnValue({ data: undefined, isLoading: false, error: { message: "Unavailable" }, mutate: retry });
    render(<TrendsDataProvider mode="global" cohort={cohort}><ActivityCalendarChart /></TrendsDataProvider>);
    expect(screen.getByRole("alert").textContent).toContain("could not be loaded");
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    expect(retry).toHaveBeenCalledOnce();
    await waitFor(() => expect(screen.getByRole("button", { name: "Retry" })).toBeTruthy());
  });
});
