import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { ProBoard } from "../ProBoard";

const minutesAgo = (minutes: number) => new Date(Date.now() - minutes * 60_000).toISOString();
const player = (extra: Record<string, unknown> = {}) => ({ race: "protoss", league: "grandmaster", rating: 5100, playedAt: minutesAgo(12), ...extra });
const game = (extra: Record<string, unknown> = {}) => ({ map: "Blackrock", opponentRace: "terran", won: true, durationSec: 640, playedAt: minutesAgo(20), ...extra });
const pro = (extra: Record<string, unknown> = {}) => ({
  ...player({ race: "zerg", rating: 5134, playedAt: minutesAgo(4) }),
  nickname: "Reynor",
  team: "TeamX",
  live: { platform: "twitch", channel: "reynor", url: "https://www.twitch.tv/reynor", viewers: 120 },
  games: [game(), game({ won: false, opponentRace: "zerg", map: "Lockdown", playedAt: minutesAgo(50), durationSec: 300 })],
  ...extra,
});
const answer = (extra: Record<string, unknown> = {}) =>
  ({ ok: true, json: async () => ({ available: true, showNames: false, pros: [], players: [player(), player({ race: "terran", rating: 4900, playedAt: minutesAgo(30) })], fetchedAt: minutesAgo(1), ...extra }) });

const fetchMock = vi.fn();
const settle = () => act(async () => { await Promise.resolve(); await Promise.resolve(); await Promise.resolve(); });

beforeEach(() => { vi.stubGlobal("fetch", fetchMock); });
afterEach(() => { cleanup(); fetchMock.mockReset(); vi.unstubAllGlobals(); vi.useRealTimers(); });

describe("ProBoard", () => {
  it("shows the players with race, rating, league and age, and no names, while the names gate is off", async () => {
    fetchMock.mockResolvedValue(answer());
    render(<ProBoard />);
    expect(screen.getByText("Loading the pros board")).toBeTruthy();
    expect(fetchMock.mock.calls[0][1]).toMatchObject({ credentials: "omit" });
    await settle();
    expect(screen.queryByText("Loading the pros board")).toBeNull();
    expect(screen.getByRole("heading", { level: 2, name: "Playing now" })).toBeTruthy();
    expect(screen.queryByRole("heading", { name: "Pros playing now" })).toBeNull();
    expect(screen.getByText("Protoss")).toBeTruthy();
    expect(screen.getByText("5,100 MMR")).toBeTruthy();
    expect(screen.getAllByText("Grandmaster")).toHaveLength(2);
    expect(screen.getByText("12m ago")).toBeTruthy();
  });

  it("lists pros first with their team, last games and a live link, then the other players", async () => {
    fetchMock.mockResolvedValue(answer({ showNames: true, pros: [pro(), pro({ nickname: "Serral", live: null, games: [], team: null })] }));
    render(<ProBoard names />);
    await settle();
    const headings = screen.getAllByRole("heading", { level: 2 }).map(heading => heading.textContent);
    expect(headings).toEqual(["Pros playing now", "Also playing now"]);
    const card = screen.getByRole("heading", { level: 3, name: "Reynor" }).closest("li") as HTMLElement;
    expect(within(card).getByText("TeamX")).toBeTruthy();
    expect(within(card).getByText("Live")).toBeTruthy();
    expect(within(card).getByText("Win")).toBeTruthy();
    expect(within(card).getByText("Loss")).toBeTruthy();
    expect(within(card).getByText(/11 min game · 20m ago/)).toBeTruthy();
    const watch = within(card).getByRole("link", { name: /Watch reynor live/ });
    expect(watch.getAttribute("href")).toBe("https://www.twitch.tv/reynor");
    expect(watch.getAttribute("target")).toBe("_blank");
    expect(watch.getAttribute("rel")).toBe("noopener noreferrer");
    const other = screen.getByRole("heading", { level: 3, name: "Serral" }).closest("li") as HTMLElement;
    expect(within(other).queryByRole("link")).toBeNull();
    expect(within(other).queryByText("Last games")).toBeNull();
  });

  it("says plainly when no pro or no player was found", async () => {
    fetchMock.mockResolvedValue(answer({ showNames: true, pros: [], players: [] }));
    render(<ProBoard names />);
    await settle();
    expect(screen.getByText("No known pro has played a ladder game in the last hour.")).toBeTruthy();
    expect(screen.getByText(/No Grandmaster ladder game in the last hour was found/)).toBeTruthy();
  });

  it("starts closed when the server says so, asks for nothing, and offers the live page", () => {
    render(<ProBoard closed />);
    expect(screen.getByText("Pros on Ladder is not available yet.")).toBeTruthy();
    expect(screen.getByRole("link", { name: "Live streams" }).getAttribute("href")).toBe("/live");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("shows the closed notice when the answer says the gate is off", async () => {
    fetchMock.mockResolvedValue({ ok: true, json: async () => ({ available: false }) });
    render(<ProBoard />);
    await settle();
    expect(screen.getByText("Pros on Ladder is not available yet.")).toBeTruthy();
  });

  it("offers a retry after a failure, moving focus to the region that stays", async () => {
    fetchMock.mockRejectedValueOnce(new Error("down")).mockResolvedValue(answer());
    render(<ProBoard />);
    await settle();
    expect(screen.getByText(/could not be loaded right now/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    expect(document.activeElement?.getAttribute("tabindex")).toBe("-1");
    await settle();
    expect(screen.getByText("5,100 MMR")).toBeTruthy();
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("shapes the loading state like the board: pro cards only when names are shown", () => {
    fetchMock.mockReturnValue(new Promise(() => {}));
    const { container, rerender } = render(<ProBoard />);
    const tiles = container.querySelectorAll("[aria-hidden]").length;
    rerender(<ProBoard names />);
    expect(container.querySelectorAll("[aria-hidden]").length).toBeGreaterThan(tiles);
  });

  it("asks again quietly every couple of minutes while the tab is visible, keeping the board on screen", async () => {
    vi.useFakeTimers();
    fetchMock.mockResolvedValueOnce(answer()).mockResolvedValueOnce(answer({ players: [player({ rating: 5300 })] })).mockRejectedValue(new Error("blip"));
    render(<ProBoard />);
    await act(async () => { await vi.advanceTimersByTimeAsync(0); });
    expect(screen.getByText("5,100 MMR")).toBeTruthy();
    await act(async () => { await vi.advanceTimersByTimeAsync(2 * 60_000); });
    expect(screen.queryByText("Loading the pros board")).toBeNull();
    expect(screen.getByText("5,300 MMR")).toBeTruthy();
    await act(async () => { await vi.advanceTimersByTimeAsync(2 * 60_000); });
    expect(screen.getByText("5,300 MMR")).toBeTruthy();
    expect(screen.queryByText(/could not be loaded/)).toBeNull();
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it("does not ask while the tab is hidden", async () => {
    vi.useFakeTimers();
    fetchMock.mockResolvedValue(answer());
    const visibility = vi.spyOn(document, "visibilityState", "get").mockReturnValue("hidden");
    render(<ProBoard />);
    await act(async () => { await vi.advanceTimersByTimeAsync(5 * 60_000); });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    visibility.mockRestore();
  });
});
