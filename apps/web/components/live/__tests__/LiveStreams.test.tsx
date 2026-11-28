import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { LiveStreams } from "../LiveStreams";

const row = (n: number, extra: Record<string, unknown> = {}) => ({
  id: `twitch:${n}`, platform: "twitch", channel: `Chan${n}`, title: `Title ${n}`, language: "en", viewers: n * 100,
  startedAt: "2026-11-27T10:00:00Z", url: `https://www.twitch.tv/chan${n}`, ...extra,
});
const kick = (n: number) => row(n, { id: `kick:${n}`, platform: "kick", language: "pt", url: `https://kick.com/chan${n}` });
const answer = (streams: unknown[], platforms = { twitch: "ok", kick: "ok" }) =>
  ({ ok: true, json: async () => ({ streams, platforms, fetchedAt: "2026-11-27T12:00:00.000Z" }) });

const fetchMock = vi.fn();
const settle = () => act(async () => { await Promise.resolve(); await Promise.resolve(); });
const pick = (label: string, value: string) => fireEvent.change(screen.getByLabelText(label), { target: { value } });
const titles = () => screen.getAllByRole("heading", { level: 3 }).map(node => node.textContent?.replace(/ \(opens.*$/, ""));

beforeEach(() => { vi.stubGlobal("fetch", fetchMock); });
afterEach(() => { cleanup(); fetchMock.mockReset(); vi.unstubAllGlobals(); vi.useRealTimers(); });

describe("LiveStreams", () => {
  it("shows a loading state, then cards with the channel, platform and viewers", async () => {
    fetchMock.mockResolvedValue(answer([row(1), kick(2)]));
    render(<LiveStreams />);
    expect(screen.getByText("Loading live streams")).toBeTruthy();
    expect((screen.getByLabelText("Language", { selector: "select" }) as HTMLSelectElement).disabled).toBe(true);
    await settle();
    expect(fetchMock.mock.calls[0][0]).toMatch(/\/v1\/live-streams$/);
    expect(fetchMock.mock.calls[0][1]).toMatchObject({ credentials: "omit" });
    expect(titles()).toEqual(["Title 2", "Title 1"]);
    const link = screen.getByRole("link", { name: /Title 2/ });
    expect(link.getAttribute("href")).toBe("https://kick.com/chan2");
    expect(link.getAttribute("target")).toBe("_blank");
    expect(link.getAttribute("rel")).toBe("noopener noreferrer");
    expect(screen.getByText("200 viewers")).toBeTruthy();
    expect(screen.getByText(/2 of 2 live streams/)).toBeTruthy();
  });

  it("filters by platform and by language, and puts small channels first on request", async () => {
    fetchMock.mockResolvedValue(answer([row(1), row(3), kick(2)]));
    render(<LiveStreams />);
    await settle();
    pick("Order", "small");
    expect(titles()).toEqual(["Title 1", "Title 2", "Title 3"]);
    pick("Platform", "kick");
    expect(titles()).toEqual(["Title 2"]);
    pick("Platform", "all");
    pick("Language", "en");
    expect(titles()).toEqual(["Title 1", "Title 3"]);
    expect(within(screen.getByLabelText("Language")).getByRole("option", { name: "Portuguese (1)" })).toBeTruthy();
  });

  it("offers a reset when filters hide every stream", async () => {
    fetchMock.mockResolvedValue(answer([row(1)]));
    render(<LiveStreams />);
    await settle();
    pick("Platform", "kick");
    expect(screen.getByText("No live streams match these filters.")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Show all streams" }));
    expect(titles()).toEqual(["Title 1"]);
    expect(document.activeElement).toBe(screen.getByText(/1 of 1 live stream/));
  });

  it("shows every stream again when the chosen language has dropped out of the list", async () => {
    vi.useFakeTimers();
    fetchMock.mockResolvedValueOnce(answer([row(1), kick(2)])).mockResolvedValueOnce(answer([row(1), row(3)]));
    render(<LiveStreams />);
    await settle();
    pick("Language", "pt");
    expect(titles()).toEqual(["Title 2"]);
    await act(async () => { vi.advanceTimersByTime(60_000); });
    await settle();
    expect((screen.getByLabelText("Language") as HTMLSelectElement).value).toBe("all");
    expect(titles()).toEqual(["Title 3", "Title 1"]);
    expect(screen.getByText(/2 of 2 live streams/)).toBeTruthy();
  });

  it("explains an empty list, and a listing that is switched off", async () => {
    fetchMock.mockResolvedValue(answer([]));
    const { unmount } = render(<LiveStreams />);
    await settle();
    expect(screen.getByText(/No StarCraft II streams are live on Twitch and Kick right now/)).toBeTruthy();
    unmount();
    fetchMock.mockResolvedValue(answer([], { twitch: "off", kick: "off" }));
    render(<LiveStreams />);
    await settle();
    expect(screen.getByText(/not switched on/)).toBeTruthy();
  });

  it("names a platform that could not be refreshed", async () => {
    fetchMock.mockResolvedValue(answer([row(1)], { twitch: "ok", kick: "stale" }));
    render(<LiveStreams />);
    await settle();
    expect(screen.getByText(/Kick could not be refreshed, so its channels/)).toBeTruthy();
  });

  it("says their channels when both platforms are stale", async () => {
    fetchMock.mockResolvedValue(answer([row(1)], { twitch: "stale", kick: "stale" }));
    render(<LiveStreams />);
    await settle();
    expect(screen.getByText(/Twitch and Kick could not be refreshed, so their channels/)).toBeTruthy();
  });

  it("does not claim a platform that failed has nothing live", async () => {
    fetchMock.mockResolvedValue(answer([], { twitch: "error", kick: "ok" }));
    render(<LiveStreams />);
    await settle();
    expect(screen.getByText(/No StarCraft II streams are live on Kick right now/)).toBeTruthy();
    expect(screen.queryByText(/live on Twitch/)).toBeNull();
  });

  it("shows an error with Retry, and loads again when it is pressed", async () => {
    fetchMock.mockResolvedValueOnce({ ok: false, json: async () => ({}) });
    render(<LiveStreams />);
    await settle();
    expect(screen.getByText(/unavailable right now/)).toBeTruthy();
    fetchMock.mockResolvedValue(answer([row(1)]));
    const region = screen.getByRole("button", { name: "Retry live streams" }).parentElement?.parentElement;
    fireEvent.click(screen.getByRole("button", { name: "Retry live streams" }));
    expect(document.activeElement).toBe(region);
    await settle();
    expect(titles()).toEqual(["Title 1"]);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("skips the minute reload while the tab is hidden", async () => {
    vi.useFakeTimers();
    fetchMock.mockResolvedValue(answer([row(1)]));
    render(<LiveStreams />);
    await settle();
    const visibility = vi.spyOn(document, "visibilityState", "get").mockReturnValue("hidden");
    await act(async () => { vi.advanceTimersByTime(180_000); });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    visibility.mockRestore();
    await act(async () => { vi.advanceTimersByTime(60_000); });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("reloads every minute and keeps the list when a reload fails", async () => {
    vi.useFakeTimers();
    fetchMock.mockResolvedValueOnce(answer([row(1)])).mockRejectedValueOnce(new TypeError("offline"));
    render(<LiveStreams />);
    await settle();
    await act(async () => { vi.advanceTimersByTime(60_000); });
    await settle();
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(titles()).toEqual(["Title 1"]);
  });
});
