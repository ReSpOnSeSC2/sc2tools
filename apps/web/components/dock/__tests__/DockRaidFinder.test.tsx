import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { DockRaidFinder } from "../DockRaidFinder";

const stream = (n: number, extra: Record<string, unknown> = {}) => ({
  id: `twitch:${n}`, platform: "twitch", channel: `Chan${n}`, title: "Ladder", language: "en", viewers: n * 3, startedAt: "2026-11-28T10:00:00Z",
  url: `https://www.twitch.tv/chan${n}`, relation: null, small: true, raidable: true, ...extra,
});
const entry = (extra: Record<string, unknown> = {}) => ({ id: "h1", dir: "out", channel: "Chan1", viewers: 3, state: "queued", at: Date.UTC(2026, 10, 28, 12), ...extra });
const base = { reason: null, platforms: { twitch: "ok", kick: "ok" }, candidates: [stream(1), stream(2, { relation: "raided" })], pending: null, history: [] };
const reply = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
let fetcher: ReturnType<typeof vi.fn>;
const writes = () => fetcher.mock.calls.filter(call => call[1]?.method === "POST");

beforeEach(() => {
  fetcher = vi.fn(async (_url: string, init?: RequestInit) => (init?.method === "POST"
    ? reply({ ...base, pending: { id: "h1", channel: "Chan1", at: Date.now() }, history: [entry()], result: { state: "queued", channel: "Chan1" } }) : reply(base)));
  vi.stubGlobal("fetch", fetcher);
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); vi.useRealTimers(); });

it("shows a skeleton shaped like the list, then the ranked channels with links", async () => {
  render(<DockRaidFinder token="dock-token" />);
  expect(screen.getByText("Loading live channels")).toBeTruthy();
  await screen.findByRole("link", { name: /Chan1/ });
  expect(screen.queryByText("Loading live channels")).toBeNull();
  expect(screen.getByRole("link", { name: /Chan1/ }).getAttribute("href")).toBe("https://www.twitch.tv/chan1");
  expect(screen.getByText(/You raided them/)).toBeTruthy();
  expect(String(fetcher.mock.calls[0][0])).toContain("/v1/multichat/dock-token/raids");
});

it("Start raid asks first, sends nothing until confirmed, and then shows the queued answer in place", async () => {
  render(<DockRaidFinder token="dock-token" />);
  fireEvent.click(await screen.findByRole("button", { name: "Start raid on Chan1" }));
  const dialog = screen.getByRole("dialog");
  expect(within(dialog).getByText("Raid Chan1?")).toBeTruthy();
  expect(writes()).toHaveLength(0);
  fireEvent.click(within(dialog).getByRole("button", { name: "Not now" }));
  expect(writes()).toHaveLength(0);
  fireEvent.click(screen.getByRole("button", { name: "Start raid on Chan1" }));
  fireEvent.click(within(screen.getByRole("dialog")).getByRole("button", { name: "Start raid" }));
  await screen.findByText(/Raid to Chan1 queued/);
  expect(JSON.parse(String(writes()[0][1]?.body))).toEqual({ action: "start", streamId: "twitch:1", confirmed: true });
  expect(screen.queryByText(/raid to Chan1 sent|done/i)).toBeNull();
  expect(screen.getByRole("button", { name: "Cancel raid" })).toBeTruthy();
  expect(screen.queryByRole("button", { name: "Start raid on Chan2" })).toBeNull();
});

it("cancel is confirmed too, then reports Twitch's answer", async () => {
  fetcher.mockImplementation(async (_url: string, init?: RequestInit) => (init?.method === "POST"
    ? reply({ ...base, history: [entry({ state: "canceled" })], result: { state: "canceled", channel: "Chan1" } })
    : reply({ ...base, pending: { id: "h1", channel: "Chan1", at: Date.now() }, history: [entry()] })));
  render(<DockRaidFinder token="dock-token" />);
  fireEvent.click(await screen.findByRole("button", { name: "Cancel raid" }));
  expect(writes()).toHaveLength(0);
  fireEvent.click(within(screen.getByRole("dialog")).getByRole("button", { name: "Cancel raid" }));
  await screen.findByText("Raid to Chan1 cancelled. Twitch confirmed it.");
  expect(JSON.parse(String(writes()[0][1]?.body))).toEqual({ action: "cancel", confirmed: true });
  await waitFor(() => expect(screen.queryByRole("button", { name: "Cancel raid" })).toBeNull());
});

it("Twitch's refusal is shown where the raid was started, and the list is read again", async () => {
  fetcher.mockImplementation(async (_url: string, init?: RequestInit) => (init?.method === "POST"
    ? reply({ error: { code: "raid_refused", message: "Twitch refused this raid. The channel may block you or not accept raids." } }, 409)
    : reply({ ...base, history: [entry({ state: "failed" })] })));
  render(<DockRaidFinder token="dock-token" />);
  fireEvent.click(await screen.findByRole("button", { name: "Start raid on Chan1" }));
  fireEvent.click(within(screen.getByRole("dialog")).getByRole("button", { name: "Start raid" }));
  expect((await screen.findByRole("alert")).textContent).toContain("Twitch refused this raid");
  await waitFor(() => expect(fetcher.mock.calls.filter(call => call[1]?.method !== "POST")).toHaveLength(2));
  expect(writes()).toHaveLength(1);
  expect(screen.getByRole("alert").textContent).toContain("Twitch refused");
});

it("without the permission the list still shows with links, and no Start raid button", async () => {
  fetcher.mockResolvedValue(reply({ ...base, reason: "raid_permission_required" }));
  render(<DockRaidFinder token="dock-token" />);
  await screen.findByRole("link", { name: /Chan1/ });
  expect(screen.queryByRole("button", { name: /Start raid/ })).toBeNull();
  expect(screen.getByText(/Allow raids in Settings/)).toBeTruthy();
  expect(screen.getByRole("link", { name: "Raid settings" }).getAttribute("href")).toBe("/settings?tab=chat#twitch-raids");
});

it("a Kick channel is listed for its link only", async () => {
  fetcher.mockResolvedValue(reply({ ...base, candidates: [stream(7, { id: "kick:7", platform: "kick", url: "https://kick.com/k7", raidable: false, channel: "K7" })] }));
  render(<DockRaidFinder token="dock-token" />);
  expect((await screen.findByRole("link", { name: /K7/ })).getAttribute("href")).toBe("https://kick.com/k7");
  expect(screen.queryByRole("button", { name: /Start raid/ })).toBeNull();
});

it("an empty list and a failed load each say so, and Refresh reads again", async () => {
  fetcher.mockResolvedValueOnce(reply({ error: { code: "x", message: "The API is down." } }, 503)).mockResolvedValue(reply({ ...base, candidates: [] }));
  render(<DockRaidFinder token="dock-token" />);
  expect((await screen.findByRole("alert")).textContent).toContain("The API is down.");
  fireEvent.click(screen.getByRole("button", { name: "Refresh channels" }));
  await screen.findByText("No StarCraft II channels are live right now.");
  expect(screen.queryByRole("alert")).toBeNull();
});

it("the history lists raids sent and received, a queued raid still only queued", async () => {
  fetcher.mockResolvedValue(reply({ ...base, history: [entry(), entry({ id: "h2", dir: "in", channel: "Raider", viewers: 12, state: "received" })] }));
  render(<DockRaidFinder token="dock-token" />);
  await screen.findByText("Raid history");
  expect(screen.getByText(/Queued/)).toBeTruthy();
  expect(screen.getByText(/12 viewers joined/)).toBeTruthy();
});
