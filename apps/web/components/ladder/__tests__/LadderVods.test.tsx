import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { LadderVods } from "../LadderVods";

const vod = (n: number, extra: Record<string, unknown> = {}) => ({
  id: String(n),
  vodUrl: `https://www.twitch.tv/videos/${n}?t=${n}s`,
  channel: `streamer${n}`,
  subscribersOnly: false,
  streamerRace: "zerg",
  opponentRace: "terran",
  rating: 6700,
  map: "Blackrock LE",
  durationSec: 764,
  playedAt: new Date(Date.now() - 3 * 3_600_000).toISOString(),
  ...extra,
});
const page = (results: unknown[], next: string | null = null) =>
  ({ ok: true, json: async () => ({ available: true, results, next, fetchedAt: "2026-11-28T08:00:00.000Z" }) });
const closed = { ok: true, json: async () => ({ available: false }) };

const fetchMock = vi.fn();
const settle = () => act(async () => { await Promise.resolve(); await Promise.resolve(); await Promise.resolve(); });
const pick = (label: string, value: string) => fireEvent.change(screen.getByLabelText(label), { target: { value } });
const requested = (call = 0) => new URL(fetchMock.mock.calls[call][0] as string);

beforeEach(() => { vi.stubGlobal("fetch", fetchMock); });
afterEach(() => { cleanup(); fetchMock.mockReset(); vi.unstubAllGlobals(); });

describe("LadderVods", () => {
  it("starts with Terran vs Zerg at 5,000 and up, drawing the same form while it loads", async () => {
    fetchMock.mockResolvedValue(page([vod(1)]));
    render(<LadderVods />);
    expect(screen.getByText("Searching ladder games")).toBeTruthy();
    expect((screen.getByLabelText("Matchup") as HTMLSelectElement).value).toBe("tvz");
    expect(requested().searchParams.get("matchup")).toBe("tvz");
    expect(requested().searchParams.get("rating")).toBe("5000");
    expect(fetchMock.mock.calls[0][1]).toMatchObject({ credentials: "omit" });
    await settle();
    expect(screen.queryByText("Searching ladder games")).toBeNull();
  });

  it("shows the matchup, rating, map, length, age and channel, and links to the VOD", async () => {
    fetchMock.mockResolvedValue(page([vod(7)]));
    render(<LadderVods />);
    await settle();
    expect(screen.getByText("6,700 MMR")).toBeTruthy();
    expect(screen.getByText(/Blackrock LE · 13 min · /)).toBeTruthy();
    expect(screen.getByText("Zerg")).toBeTruthy();
    expect(screen.getByText("Terran")).toBeTruthy();
    const link = screen.getByRole("link", { name: /Watch streamer7 on Twitch/ });
    expect(link.getAttribute("href")).toBe("https://www.twitch.tv/videos/7?t=7s");
    expect(link.getAttribute("target")).toBe("_blank");
    expect(link.getAttribute("rel")).toBe("noopener noreferrer");
    expect(screen.getByText(/1 recent game with a VOD/)).toBeTruthy();
  });

  it("falls back to a plain VOD link without a channel and marks subscriber-only VODs", async () => {
    fetchMock.mockResolvedValue(page([vod(1, { channel: null, subscribersOnly: true })]));
    render(<LadderVods />);
    await settle();
    expect(screen.getByRole("link", { name: /Watch the VOD on Twitch/ })).toBeTruthy();
    expect(screen.getByText("Subscribers only")).toBeTruthy();
  });

  it("searches with the chosen menus when Search is pressed, and again when the form is submitted", async () => {
    fetchMock.mockResolvedValue(page([vod(1)]));
    render(<LadderVods />);
    await settle();
    pick("Matchup", "zvp");
    pick("Length", "10");
    pick("Map", "55373");
    expect(fetchMock).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByRole("button", { name: "Search" }));
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(Object.fromEntries(requested(1).searchParams)).toEqual({ matchup: "zvp", rating: "5000", length: "10", map: "55373" });
    await settle();
    fireEvent.submit(screen.getByRole("button", { name: "Search" }).closest("form")!);
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it("clears the menus to any and sends no filter", async () => {
    fetchMock.mockResolvedValue(page([vod(1)]));
    render(<LadderVods />);
    await settle();
    fireEvent.click(screen.getByRole("button", { name: "Clear filters" }));
    expect((screen.getByLabelText("Rating") as HTMLSelectElement).value).toBe("");
    fireEvent.click(screen.getByRole("button", { name: "Search" }));
    expect(requested(1).search).toBe("");
  });

  it("appends the next page with the cursor, skips repeats and moves focus when the games run out", async () => {
    fetchMock
      .mockResolvedValueOnce(page([vod(1), vod(2)], "cursor-1"))
      .mockResolvedValueOnce(page([vod(2), vod(3)], null));
    render(<LadderVods />);
    await settle();
    fireEvent.click(screen.getByRole("button", { name: "Show more games" }));
    expect(requested(1).searchParams.get("after")).toBe("cursor-1");
    await settle();
    expect(screen.getAllByRole("listitem")).toHaveLength(3);
    expect(screen.queryByRole("button", { name: /Show more/ })).toBeNull();
    expect(screen.getByText(/3 recent games with a VOD · that is all for this search/)).toBeTruthy();
    expect(document.activeElement?.textContent).toMatch(/that is all/);
  });

  it("keeps the games and offers another try when a later page fails", async () => {
    fetchMock.mockResolvedValueOnce(page([vod(1)], "cursor-1")).mockRejectedValueOnce(new Error("offline"));
    render(<LadderVods />);
    await settle();
    fireEvent.click(screen.getByRole("button", { name: "Show more games" }));
    await settle();
    expect(screen.getByText("More games could not be loaded.")).toBeTruthy();
    expect(screen.getAllByRole("listitem")).toHaveLength(1);
    expect(screen.getByRole("button", { name: "Try again" })).toBeTruthy();
  });

  it("says the finder is not available yet, switches the form off and lists nothing", async () => {
    fetchMock.mockResolvedValue(closed);
    render(<LadderVods />);
    await settle();
    expect(screen.getByText("The ladder VOD finder is not available yet.")).toBeTruthy();
    expect(screen.getByRole("link", { name: "Live streams" }).getAttribute("href")).toBe("/live");
    expect((screen.getByLabelText("Map") as HTMLSelectElement).disabled).toBe(true);
    expect((screen.getByRole("button", { name: "Search" }) as HTMLButtonElement).disabled).toBe(true);
    expect(screen.queryAllByRole("listitem")).toHaveLength(0);
  });

  it("explains an empty search and widens it on request", async () => {
    fetchMock.mockResolvedValueOnce(page([])).mockResolvedValueOnce(page([vod(1)]));
    render(<LadderVods />);
    await settle();
    expect(screen.getByText(/No recent ladder game with a Twitch VOD matches these filters/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Search any game" }));
    expect(requested(1).search).toBe("");
    expect((screen.getByLabelText("Matchup") as HTMLSelectElement).value).toBe("");
    await settle();
    expect(screen.getAllByRole("listitem")).toHaveLength(1);
  });

  it("shows an error with a retry that searches again and keeps focus on the region", async () => {
    fetchMock.mockRejectedValueOnce(new Error("offline")).mockResolvedValueOnce(page([vod(1)]));
    render(<LadderVods />);
    await settle();
    expect(screen.getByText(/search is unavailable right now/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Retry search" }));
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(document.activeElement?.getAttribute("tabindex")).toBe("-1");
    await settle();
    expect(screen.getAllByRole("listitem")).toHaveLength(1);
  });

  it("treats an answer it cannot read as an error and ignores a search that was replaced", async () => {
    fetchMock.mockResolvedValueOnce({ ok: true, json: async () => ({ nonsense: true }) });
    render(<LadderVods />);
    await settle();
    expect(screen.getByRole("button", { name: "Retry search" })).toBeTruthy();
    cleanup();

    let release: (value: unknown) => void = () => undefined;
    fetchMock.mockReset();
    fetchMock
      .mockReturnValueOnce(new Promise(resolve => { release = resolve; }))
      .mockResolvedValueOnce(page([vod(2)]));
    render(<LadderVods />);
    fireEvent.click(screen.getByRole("button", { name: "Search" }));
    await settle();
    await act(async () => { release(page([vod(1)])); });
    expect(screen.getAllByRole("listitem")).toHaveLength(1);
    expect(screen.getByRole("link", { name: /streamer2/ })).toBeTruthy();
  });
});
