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
const titles = () => screen.getAllByRole("heading", { level: 3 }).map(node => node.textContent?.replace(/ \(opens.*$/, ""));

beforeEach(() => { vi.stubGlobal("fetch", fetchMock); });
afterEach(() => { cleanup(); fetchMock.mockReset(); vi.unstubAllGlobals(); vi.useRealTimers(); });

describe("LiveStreams", () => {
  it("shows a loading state, then cards with the channel, platform and viewers", async () => {
    fetchMock.mockResolvedValue(answer([row(1), kick(2)]));
    render(<LiveStreams />);
    expect(screen.getByText("Loading live streams")).toBeTruthy();
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
    fireEvent.click(screen.getByRole("radio", { name: "Small channels first" }));
    expect(titles()).toEqual(["Title 1", "Title 2", "Title 3"]);
    fireEvent.click(screen.getByRole("radio", { name: "Kick" }));
    expect(titles()).toEqual(["Title 2"]);
    fireEvent.click(screen.getByRole("radio", { name: "All platforms" }));
    fireEvent.change(screen.getByLabelText("Language"), { target: { value: "en" } });
    expect(titles()).toEqual(["Title 1", "Title 3"]);
    expect(within(screen.getByLabelText("Language")).getByRole("option", { name: "Portuguese (1)" })).toBeTruthy();
  });

  it("offers a reset when filters hide every stream", async () => {
    fetchMock.mockResolvedValue(answer([row(1)]));
    render(<LiveStreams />);
    await settle();
    fireEvent.click(screen.getByRole("radio", { name: "Kick" }));
    expect(screen.getByText("No live streams match these filters.")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Show all streams" }));
    expect(titles()).toEqual(["Title 1"]);
  });

  it("explains an empty list, and a listing that is switched off", async () => {
    fetchMock.mockResolvedValue(answer([]));
    const { unmount } = render(<LiveStreams />);
    await settle();
    expect(screen.getByText(/No StarCraft II streams are live/)).toBeTruthy();
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
    expect(screen.getByText(/Kick could not be refreshed/)).toBeTruthy();
  });

  it("shows an error with Retry, and loads again when it is pressed", async () => {
    fetchMock.mockResolvedValueOnce({ ok: false, json: async () => ({}) });
    render(<LiveStreams />);
    await settle();
    expect(screen.getByText(/unavailable right now/)).toBeTruthy();
    fetchMock.mockResolvedValue(answer([row(1)]));
    fireEvent.click(screen.getByRole("button", { name: "Retry live streams" }));
    await settle();
    expect(titles()).toEqual(["Title 1"]);
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
