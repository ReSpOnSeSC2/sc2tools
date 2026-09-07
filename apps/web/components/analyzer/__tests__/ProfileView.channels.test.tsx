import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, within } from "@testing-library/react";
import { ProfileView } from "../ProfileView";
import type { PulseRaceBreakdown } from "../OpponentRaceMmr";
import type { GlobalPlayerIdentity } from "@/lib/opponentGroups";

const useApiMock = vi.fn();
const usePlayerChannelsMock = vi.fn();
const channelsForMock = vi.fn();
vi.mock("@/lib/clientApi", () => ({ useApi: (...args: unknown[]) => useApiMock(...args) }));
vi.mock("../usePlayerChannels", () => ({ usePlayerChannels: (...args: unknown[]) => usePlayerChannelsMock(...args) }));
vi.mock("@/lib/useMyDisplayName", () => ({ useMyDisplayName: () => "Me" }));
vi.mock("@/lib/useLocalStorageState", () => ({ useLocalStorageState: () => [true, vi.fn()] }));
vi.mock("../OpponentNotesCard", () => ({ OpponentNotesCard: () => <section aria-label="Opponent notes" /> }));
vi.mock("../OpponentReplayHistory", () => ({ OpponentReplayHistory: () => <section aria-label="Replay history" /> }));
vi.mock("../OpponentIdentityCandidates", () => ({ OpponentIdentityCandidates: () => null }));
vi.mock("../OpponentIdentitySubmission", () => ({ OpponentIdentitySubmission: () => <section aria-label="Player identity review" /> }));
vi.mock("../OpponentDiagnosticsPanel", () => ({ OpponentDiagnosticsPanel: () => null }));
vi.mock("@/components/ui/Icon", () => ({ Icon: () => <span /> }));
vi.mock("../LadderContextCard", () => ({ LadderContextCard: () => null }));
vi.mock("../StrategyTendencyChart", () => ({ StrategyTendencyChart: () => null }));
vi.mock("../PredictedStrategiesList", () => ({ PredictedStrategiesList: () => null }));
vi.mock("../h2h/H2HTrendsSection", () => ({ H2HTrendsSection: () => null }));

beforeEach(() => {
  useApiMock.mockReset(); usePlayerChannelsMock.mockReset(); channelsForMock.mockReset();
  usePlayerChannelsMock.mockReturnValue(channelsForMock);
  useApiMock.mockImplementation((path: string) => ({
    data: path.includes("pulse-races") ? undefined : { name: "Barcode", revealedName: "Harstem", pulseCharacterId: "994428", toonHandle: "2-S2-1-12345", games: [] },
    isLoading: false,
  }));
});
afterEach(cleanup);

const confirmedIdentity: GlobalPlayerIdentity = {
  groupKey: "identity:pulse:236671", displayName: "Strange", revision: 1,
  target: { key: "pulse:236671", pulseCharacterId: "236671", toonHandle: "2-S2-2-632713" },
};
const confirmedProfile = {
  pulseId: "8703807", pulseCharacterId: "8703807", toonHandle: "2-S2-2-240434",
  name: "IIIIllll", displayNameSample: "IIIIllll", revealedName: "Old Pulse label",
  globalIdentity: confirmedIdentity, mmr: 5275, games: [],
};
const confirmedRaces: PulseRaceBreakdown = {
  resolved: true, topRace: "Protoss", topMmr: 6100,
  races: [{ race: "Protoss", mmr: 6100, games: 80, league: "Grandmaster", region: "EU" }],
  ladderIdentity: { pulseCharacterId: "236671", toonHandle: "2-S2-2-632713", displayName: "Strange", region: "EU", confirmed: true },
};

describe("opponent profile channel placement", () => {
  it("shows named channel buttons once in the top identity header, before notes and replays", () => {
    channelsForMock.mockReturnValue({ twitch: "https://www.twitch.tv/harstem", youtube: "https://www.youtube.com/@Harstem" });
    render(<ProfileView pulseId="2-S2-1-12345" onBack={vi.fn()} />);
    const header = screen.getByLabelText("Opponent profile");
    const twitch = within(header).getByRole("link", { name: "Visit Harstem's Twitch channel" });
    const youtube = within(header).getByRole("link", { name: "Visit Harstem's YouTube channel" });
    expect(twitch.getAttribute("href")).toBe("https://www.twitch.tv/harstem");
    expect(youtube.getAttribute("href")).toBe("https://www.youtube.com/@Harstem");
    expect(within(header).getByRole("group", { name: "Harstem channels" })).toBeTruthy();
    expect(within(header).getByTitle("Revealed on SC2Pulse as Harstem")).toBeTruthy();
    expect(screen.getAllByRole("link", { name: /Visit Harstem's .* channel/ })).toHaveLength(2);
    expect(header.compareDocumentPosition(screen.getByLabelText("Opponent notes")) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(header.compareDocumentPosition(screen.getByLabelText("Replay history")) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(within(screen.getByLabelText("Replay history")).queryByRole("link")).toBeNull();
  });

  it("resolves channels from the selected stable identity even when the profile omits identity fields", () => {
    useApiMock.mockReturnValue({ data: { name: "Local player", games: [] }, isLoading: false });
    channelsForMock.mockReturnValue({ youtube: "https://www.youtube.com/@localplayer" });
    render(<ProfileView pulseId="1-S2-1-267727" onBack={vi.fn()} />);
    expect(usePlayerChannelsMock).toHaveBeenCalledWith([{ pulseId: "1-S2-1-267727", pulseCharacterId: undefined, toonHandle: undefined }]);
    expect(channelsForMock).toHaveBeenCalledWith({ pulseId: "1-S2-1-267727", pulseCharacterId: undefined, toonHandle: undefined });
    expect(within(screen.getByLabelText("Opponent profile")).getByRole("link", { name: "Visit Local player's YouTube channel" })).toBeTruthy();
  });

  it("omits channel actions when the directory has no approved channel links", () => {
    channelsForMock.mockReturnValue(undefined);
    render(<ProfileView pulseId="2-S2-1-12345" onBack={vi.fn()} />);
    expect(screen.queryByRole("group", { name: /channels/ })).toBeNull();
    expect(screen.queryByRole("link", { name: /Twitch|YouTube/ })).toBeNull();
  });

  it("keeps the recorded barcode and account link beside its approved AKA and channel labels", () => {
    useApiMock.mockImplementation((path: string) => ({
      data: path.includes("pulse-races") ? confirmedRaces : confirmedProfile,
      isLoading: false,
    }));
    channelsForMock.mockReturnValue({ twitch: "https://www.twitch.tv/strange" });
    render(<ProfileView pulseId="8703807" onBack={vi.fn()} />);
    const header = screen.getByLabelText("Opponent profile");
    expect(screen.getByLabelText("Player identity review")).toBeTruthy();
    expect(within(header).getByRole("heading", { name: "IIIIllll" })).toBeTruthy();
    expect(within(header).queryByRole("heading", { name: "Strange" })).toBeNull();
    const aka = within(header).getByTitle("Confirmed by an admin as Strange");
    expect(within(aka).getByText("AKA")).toBeTruthy();
    expect(aka.textContent).toContain("Strange");
    expect(within(header).getByText("Played account · Pulse ID")).toBeTruthy();
    expect(within(header).getByRole("link", { name: "8703807" }).getAttribute("href")).toContain("id=8703807");
    expect(within(header).getByText("· toon 2-S2-2-240434")).toBeTruthy();
    expect(within(header).getByRole("link", { name: "Visit Strange's Twitch channel" })).toBeTruthy();
    expect(within(header).getByRole("link", { name: "community profile →" }).getAttribute("href")).toBe("/community/opponents/8703807");
    expect(usePlayerChannelsMock).toHaveBeenCalledWith([{ pulseId: "8703807", pulseCharacterId: "8703807", toonHandle: "2-S2-2-240434" }]);
    expect(within(header).getByRole("note", { name: "Protoss MMR 6100 for Strange's main profile" }).getAttribute("title")).toBe("Highest-rated race on Strange's confirmed main profile (SC2Pulse)");
    expect(screen.getByRole("link", { name: "View SC2Pulse profile" }).getAttribute("href")).toContain("id=236671");
    expect(screen.queryByText("Old Pulse label")).toBeNull();
    expect(screen.queryByText("5,275")).toBeNull();
  });

  it("withholds cached barcode ratings until the confirmed account's MMR response arrives", () => {
    let races: PulseRaceBreakdown = {
      resolved: true, topRace: "Random", topMmr: 5275,
      races: [{ race: "Random", mmr: 5275, games: 10, league: "Master", region: "EU" }],
      ladderIdentity: { pulseCharacterId: "8703807", toonHandle: "2-S2-2-240434", displayName: "IIIIllll", region: "EU", confirmed: false },
    };
    useApiMock.mockImplementation((path: string) => ({
      data: path.includes("pulse-races") ? races : confirmedProfile,
      isLoading: false,
    }));
    const { rerender } = render(<ProfileView pulseId="8703807" onBack={vi.fn()} />);
    expect(screen.getByRole("heading", { name: "IIIIllll" })).toBeTruthy();
    expect(screen.getByTitle("Confirmed by an admin as Strange")).toBeTruthy();
    expect(screen.queryByRole("note")).toBeNull();
    expect(screen.queryByText("MMR by race")).toBeNull();
    expect(screen.queryByText("5,275")).toBeNull();

    races = confirmedRaces;
    rerender(<ProfileView pulseId="8703807" onBack={vi.fn()} />);
    expect(screen.getByRole("note", { name: "Protoss MMR 6100 for Strange's main profile" })).toBeTruthy();
    expect(screen.getByText("MMR by race")).toBeTruthy();
    expect(screen.getByRole("link", { name: "View SC2Pulse profile" }).getAttribute("href")).toContain("id=236671");
    expect(screen.getByRole("link", { name: "8703807" }).getAttribute("href")).toContain("id=8703807");
  });
});
