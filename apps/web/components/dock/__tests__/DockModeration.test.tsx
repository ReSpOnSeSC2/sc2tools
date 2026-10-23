import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { DockClient } from "../DockClient";
import { DEFAULT_STUDIO_STATE } from "@/lib/multichat/useStudioState";
const fixture = vi.hoisted(() => ({ messages: [{ platform: "twitch", id: "1", user: "Viewer", text: "2", badges: [], atMs: 1000 }] }));
vi.mock("@/lib/multichat/useMultiChat", () => ({ useMultiChat: () => ({ ...fixture, events: [], statuses: {}, active: true }) }));
vi.mock("@/lib/multichat/useStudioUpdates", async (original) => ({ ...await original<typeof import("@/lib/multichat/useStudioUpdates")>(), useStudioUpdates: () => ({ status: "connected" }) }));
vi.mock("@/lib/multichat/useEngagementReporter", () => ({ useEngagementReporter: () => {} }));
vi.mock("@/lib/multichat/useViewerCounts", async (original) => ({ ...await original<typeof import("@/lib/multichat/useViewerCounts")>(), useViewerCounts: () => ({ platforms: [], total: null }) }));
let studio = { ...DEFAULT_STUDIO_STATE };
let managed = "";
const posts: Array<Record<string, unknown>> = [];
beforeEach(() => {
  studio = { ...DEFAULT_STUDIO_STATE }; managed = ""; posts.length = 0;
  vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
    if (url.includes("/config")) return { ok: true, json: async () => ({ config: { twitch: { enabled: true, channel: "me" }, appearance: { blockedUsers: managed } } }) };
    if (url.includes("/studio")) {
      if (init?.method === "POST") { const patch = JSON.parse(String(init.body)); posts.push(patch); studio = { ...studio, ...patch }; }
      return { ok: true, json: async () => studio };
    }
    return { ok: true, json: async () => ({}) };
  }));
});
afterEach(() => { cleanup(); vi.useRealTimers(); vi.unstubAllGlobals(); });
async function drain() { await act(async () => { for (let i=0;i<10;i++) await Promise.resolve(); }); }
it("offers six-second Undo and later Unblock, using current authoritative blocks", async () => {
  vi.useFakeTimers(); studio.blockedUsers = ["Other"];
  render(<DockClient token="token" />); await drain();
  fireEvent.click(screen.getByRole("button", { name: "Block", hidden: true }));
  fireEvent.click(screen.getByRole("button", { name: "Confirm?", hidden: true })); await drain();
  expect(posts.at(-1)).toEqual({ blockedUsers: ["Other", "Viewer"] });
  expect(screen.getByText(/Blocked Viewer/)).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "Undo" })); await drain();
  expect(posts.at(-1)).toEqual({ blockedUsers: ["Other"] });
  const summary = screen.getByText(/Blocked users \(1\)/); (summary.closest("details") as HTMLDetailsElement).open = true;
  fireEvent.click(screen.getByRole("button", { name: /Unblock other/ })); await drain();
  expect(posts.at(-1)).toEqual({ blockedUsers: [] });
});
it("expires Undo after six seconds while preserving the searchable blocklist", async () => {
  vi.useFakeTimers(); render(<DockClient token="token" />); await drain();
  fireEvent.click(screen.getByRole("button", { name: "Block", hidden: true })); fireEvent.click(screen.getByRole("button", { name: "Confirm?", hidden: true })); await drain();
  act(() => vi.advanceTimersByTime(6000)); expect(screen.queryByRole("button", { name: "Undo" })).toBeNull();
  const details = screen.getByText(/Blocked users \(1\)/).closest("details")!; details.open = true;
  fireEvent.change(within(details).getByRole("searchbox"), { target: { value: "VIEW" } });
  expect(within(details).getByRole("button", { name: /Unblock viewer/ })).toBeTruthy();
});
it("disables Block at 50 and exposes Settings-managed users read-only", async () => {
  studio.blockedUsers = Array.from({ length: 50 }, (_, i) => `user${i}`); managed = "SettingsUser";
  render(<DockClient token="token" />); await drain();
  expect((screen.getByRole("button", { name: "Block", hidden: true }) as HTMLButtonElement).disabled).toBe(true);
  expect(screen.getByText("Blocklist full — unblock someone first")).toBeTruthy();
  const details = screen.getByText(/Blocked users \(51\)/).closest("details")!; details.open = true;
  expect(within(details).getByText("50 of 50 Dock blocks")).toBeTruthy();
  fireEvent.change(within(details).getByRole("searchbox"), { target: { value: "settingsuser" } });
  expect(within(details).getByRole("link", { name: "Managed in Settings → Overlay" })).toBeTruthy();
  expect(within(details).queryByRole("button", { name: /Unblock/ })).toBeNull(); expect(posts).toHaveLength(0);
});
it.each(["dock", "settings"])("excludes case-insensitive %s blocks from the Dock poll tally", async (source) => {
  if (source === "dock") studio.blockedUsers = ["vIeWeR"]; else managed = "VIEWER";
  studio.poll = { question: "Vote?", options: ["A", "B"], startedAtMs: 1, status: "open" };
  render(<DockClient token="token" />); await drain();
  expect(screen.getByText(/0 votes —/)).toBeTruthy();
  expect(within(screen.getByTestId("dock-chat-list")).queryByText("2")).toBeNull();
});
