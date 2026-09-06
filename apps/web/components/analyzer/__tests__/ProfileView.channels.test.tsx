import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, within } from "@testing-library/react";
import { ProfileView } from "../ProfileView";

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
vi.mock("../OpponentDiagnosticsPanel", () => ({ OpponentDiagnosticsPanel: () => null }));
vi.mock("../OpponentRaceMmr", () => ({ HeadlineMmrChip: () => null, RaceMmrPanel: () => null }));
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
});
