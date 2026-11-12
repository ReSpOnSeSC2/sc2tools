import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { ChatMessage } from "@/lib/multichat/types";
import { readChatCommands } from "@/lib/multichat/chatCommandPreferences";

const fixture = vi.hoisted(() => ({
  auth: { getToken: vi.fn() },
  channels: { data: {} as unknown, error: null as unknown, isLoading: false, mutate: vi.fn() },
  accounts: { data: {} as unknown, error: null as unknown, isLoading: false, mutate: vi.fn() },
  feed: vi.fn(),
  read: vi.fn(),
}));
vi.mock("@clerk/nextjs", () => ({ useAuth: () => fixture.auth }));
vi.mock("@/lib/clientApi", async original => ({
  ...await original<typeof import("@/lib/clientApi")>(),
  useApi: (path: string) => fixture.read(path),
}));
vi.mock("@/lib/multichat/useMultiChat", () => ({ useMultiChat: fixture.feed }));
import { ChatOwnerRepliesDisclosure } from "../ChatOwnerRepliesDisclosure";

const grant = (platform: string) => ({ platform, configured: true, connected: true, chatAvailable: true, chatConsent: true, connectedAt: "2026-11-12" });
const LIVE_MESSAGE_ID = "80000001-a159-4c58-a5b0-30a13142dddc";
const row = (user: string, extra: Partial<ChatMessage> = {}): ChatMessage => ({
  platform: "twitch", id: LIVE_MESSAGE_ID, replySource: "owner_twitch", user, text: "!build PvZ", badges: [], atMs: Date.now(), ...extra,
});
const view = () => render(<ChatOwnerRepliesDisclosure owner="owner-a" token="token-a" commands={readChatCommands({ builtins: [{ id: "mmr", enabled: false }] })} />);
const open = () => fireEvent.click(screen.getByRole("button", { name: "Open live replies" }));
const action = () => screen.findByRole("button", { name: "Answer as me on Twitch for Viewer" });

beforeEach(() => {
  fixture.auth.getToken.mockReset().mockResolvedValue("jwt-owner-a");
  fixture.channels.data = { twitch: { enabled: true, channel: "owner_twitch" }, kick: { enabled: true, channel: "owner-kick", chatroomId: 42 },
    youtube: { enabled: true, channel: "@owner" }, tiktok: { enabled: true, username: "owner" },
    appearance: { blockedUsers: "Blocked" } };
  fixture.accounts.data = { platforms: [grant("twitch"), grant("kick"), grant("youtube")] };
  fixture.channels.error = fixture.accounts.error = null;
  fixture.channels.isLoading = fixture.accounts.isLoading = false;
  fixture.channels.mutate.mockReset().mockResolvedValue(undefined);
  fixture.accounts.mutate.mockReset().mockResolvedValue(undefined);
  fixture.read.mockReset().mockImplementation(path => path.endsWith("/integrations") ? fixture.accounts : fixture.channels);
  fixture.feed.mockReset().mockReturnValue({ messages: [row("Viewer")], statuses: { twitch: { state: "connected" } } });
  vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ status: "sent" }), { status: 200 })));
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

it("opens explicitly and requests a single owner-authenticated reply from the chosen live row", async () => {
  view();
  expect(fixture.read).not.toHaveBeenCalled();
  expect(fixture.feed).not.toHaveBeenCalled();
  open();
  const send = await action();
  expect(fetch).not.toHaveBeenCalled();
  fireEvent.click(send);
  fireEvent.click(send);
  expect(await screen.findByText("Reply sent to the source chat.")).toBeTruthy();
  expect(fetch).toHaveBeenCalledTimes(1);
  const [path, init] = vi.mocked(fetch).mock.calls[0];
  expect(String(path)).toMatch(/\/v1\/me\/chat-commands\/reply$/);
  expect(new Headers(init?.headers).get("authorization")).toBe("Bearer jwt-owner-a");
  expect(JSON.parse(String(init?.body))).toEqual({
    token: "token-a", platform: "twitch", source: "owner_twitch", id: LIVE_MESSAGE_ID, user: "Viewer", text: "!build PvZ",
  });
  expect(send.getAttribute("aria-disabled")).toBe("true");
  fireEvent.click(send);
  expect(fetch).toHaveBeenCalledTimes(1);
});

it("keeps the exact YouTube source and excludes old, own, blocked, TikTok and unsourced messages", async () => {
  fixture.feed.mockReturnValue({ messages: [
    row("YouTube Viewer", { platform: "youtube", id: "video000002:message" }),
    row("Legacy", { platform: "youtube", id: "old-unknown-video" }), row("Local fallback", { id: "fallback-message" }),
    row("Unsourced Twitch room", { replySource: undefined }), row("Unsourced Kick room", { platform: "kick", replySource: undefined }),
    row("Backlog", { backlog: true }), row("Streamer", { badges: ["owner"] }),
    row("Unsupported", { platform: "tiktok" }), row("Blocked"), row("Vote", { text: "!win" }),
    row("Unknown", { text: "!arbitrary" }), row("Disabled", { text: "!session" }),
  ], statuses: {} });
  view(); open();
  const panel = await screen.findByRole("region", { name: "Live command replies" });
  const buttons = within(panel).getAllByRole("button", { name: /Answer as me/ });
  expect(buttons).toHaveLength(1);
  fireEvent.click(buttons[0]);
  await screen.findByText("Reply sent to the source chat.");
  expect(JSON.parse(String(vi.mocked(fetch).mock.calls[0][1]?.body))).toMatchObject({
    platform: "youtube", id: "video000002:message", source: "video000002",
  });
  expect(fixture.feed).toHaveBeenLastCalledWith(expect.objectContaining({
    includeOfficialEvents: false, config: expect.not.objectContaining({ tiktok: expect.anything() }),
  }));
});

it("waits for configured chat-send consent before starting feeds", async () => {
  fixture.accounts.data = { platforms: [{ ...grant("twitch"), chatConsent: false }] };
  view(); open();
  expect(await screen.findByText(/configure twitch, kick or youtube chat/i)).toBeTruthy();
  expect(fixture.feed).not.toHaveBeenCalled();
  expect(fetch).not.toHaveBeenCalled();
});

it("lets the owner retry permission reads and close with Escape and restored focus", async () => {
  fixture.accounts.error = { status: 503 };
  view(); open();
  const retry = await screen.findByRole("button", { name: "Retry live replies" });
  fireEvent.click(retry);
  expect(fixture.accounts.mutate).toHaveBeenCalledTimes(1);
  expect(fixture.channels.mutate).toHaveBeenCalledTimes(1);
  retry.focus();
  fireEvent.keyDown(retry, { key: "Escape" });
  const toggle = screen.getByRole("button", { name: "Open live replies" });
  expect(document.activeElement).toBe(toggle);
  expect(fixture.feed).not.toHaveBeenCalled();
});

it("a revoked grant shows a safe failure and an unconfirmed receipt stays disabled", async () => {
  vi.mocked(fetch).mockResolvedValueOnce(Response.json({ status: "failed", message: "Connect Twitch chat sending in Settings and approve its permissions." }));
  vi.mocked(fetch).mockResolvedValueOnce(Response.json({ status: "unconfirmed" }));
  view(); open();
  const send = await action();
  fireEvent.click(send);
  await screen.findByText("Connect Twitch chat sending in Settings and approve its permissions.");
  await waitFor(() => expect(send.getAttribute("aria-disabled")).toBe("false"));
  fireEvent.click(send);
  await screen.findByText(/couldn’t confirm delivery/i);
  expect(send.getAttribute("aria-disabled")).toBe("true");
});

it("retires a pending response when the disclosure closes", async () => {
  let finish: (value: Response) => void = () => undefined;
  vi.mocked(fetch).mockImplementation(() => new Promise(resolve => { finish = resolve; }));
  view(); open();
  fireEvent.click(await action());
  await waitFor(() => expect(fetch).toHaveBeenCalledTimes(1));
  fireEvent.click(screen.getByRole("button", { name: "Close live replies" }));
  await act(async () => finish(Response.json({ status: "sent" })));
  expect(screen.queryByText("Reply sent to the source chat.")).toBeNull();
  expect(vi.mocked(fetch).mock.calls[0][1]?.signal?.aborted).toBe(true);
});
