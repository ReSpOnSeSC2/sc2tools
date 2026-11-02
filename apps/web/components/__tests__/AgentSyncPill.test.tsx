import type { ReactNode } from "react";
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeAll, beforeEach, expect, it, vi } from "vitest";
import { SWRConfig, type Cache } from "swr";
import { loadLazyHelpLink } from "@/components/help/__tests__/loadLazyHelpLink";
import type { SyncHealthResponse } from "@/lib/syncHealth";
const h = vi.hoisted(() => ({ me: undefined as undefined | { agentPaired: boolean; agentLastSeenAt: string | null; games: { total: number; latest: string | null } }, health: undefined as unknown, configs: {} as Record<string, unknown>, immediate: {} as Record<string, (value?: unknown) => void>, coalesced: {} as Record<string, (value?: unknown) => void>, fetched: vi.fn(), live: vi.fn() }));
vi.mock("@/lib/clientApi", async () => { const { default: useSWR } = await import("swr"); return { useApi: (path: string | null, config?: unknown) => { if (path) h.configs[path] = config; return useSWR(path, async (key: string) => { h.fetched(key); if (key === "/v1/me") return h.me; if (h.health instanceof Error) throw h.health; return h.health; }, { fallbackData: path === "/v1/me" ? h.me : undefined, dedupingInterval: 0, shouldRetryOnError: false }); } }; });
vi.mock("@/components/realtime/RealtimeProvider", () => ({ useRealtimeState: (handlers: typeof h.immediate) => { h.immediate = handlers; return { status: "connected", attempts: 0, bulk: false }; }, useRealtimeEvents: (handlers: typeof h.coalesced) => { h.coalesced = handlers; } }));
vi.mock("@/lib/useLiveGame", () => ({ useLiveGame: h.live }));
import { AgentSyncPill } from "../SyncStatus";
import { agentPresence } from "@/lib/agentPresence";
let cache: Cache;
// The details hold two help links and the sync-health summary; load their chunks before any render suspends on them.
beforeAll(async () => { await loadLazyHelpLink(); await import("../SyncHealthSummary"); }, 20_000);
beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(new Date("2026-10-23T12:00:00Z")); h.fetched.mockClear(); h.live.mockClear(); h.configs = {}; h.health = undefined; cache = new Map(); h.me = { agentPaired: true, agentLastSeenAt: new Date().toISOString(), games: { total: 12345, latest: "2026-10-23T11:58:00Z" } }; });
afterEach(() => { cleanup(); vi.useRealTimers(); });
function mount() { return render(<AgentSyncPill />, { wrapper: ({ children }: { children: ReactNode }) => <SWRConfig value={{ provider: () => cache }}>{children}</SWRConfig> }); }
it("uses heartbeat state and exposes connected transport only as secondary detail", () => {
  mount(); const pill = screen.getByRole("button", { name: /Agent online · 12,345 games · latest game 2 min ago/ });
  expect(h.live).not.toHaveBeenCalled(); expect(screen.queryByText("Polling")).toBeNull(); fireEvent.click(pill);
  expect(screen.getByRole("dialog", { name: "Desktop app details" }).textContent).toContain("Realtime updates: Connected");
  expect(screen.getByRole("link", { name: "Open Devices" }).getAttribute("href")).toBe("/devices");
});
it("ticks relative time with no new event and eventually marks a stale heartbeat offline", () => {
  mount(); act(() => vi.advanceTimersByTime(30_000)); expect(screen.getByRole("button", { name: /latest game 3 min ago/ })).toBeTruthy();
  act(() => vi.advanceTimersByTime(150_000)); expect(screen.getByRole("button", { name: /Agent offline · last seen 3 min ago/ })).toBeTruthy();
});
it("distinguishes no linked app, stale app and a loading account", () => {
  h.me!.agentPaired = false; let view = mount(); expect(screen.getByRole("button", { name: "No desktop app linked" })).toBeTruthy(); expect(screen.getByRole("link", { name: "Link your PC" })).toBeTruthy();
  view.unmount(); cache = new Map(); h.me!.agentPaired = true; h.me!.agentLastSeenAt = "2026-10-23T10:00:00Z"; view = mount(); expect(screen.getByRole("button", { name: /Agent offline · last seen 2 h ago/ })).toBeTruthy();
  view.unmount(); cache = new Map(); h.me = undefined; mount(); expect(screen.getByRole("status", { name: "Loading desktop app status" })).toBeTruthy();
});
it("closes its non-modal disclosure on Escape/outside click and restores focus", () => {
  mount(); const pill = screen.getByRole("button", { name: /Agent online/ }); pill.focus(); fireEvent.click(pill); fireEvent.keyDown(document, { key: "Escape" });
  expect(screen.queryByRole("dialog")).toBeNull(); expect(document.activeElement).toBe(pill); fireEvent.click(pill); fireEvent.pointerDown(document.body); expect(screen.queryByRole("dialog")).toBeNull();
  // An outside press restores focus only once the pointer's own focus has settled.
  act(() => { vi.advanceTimersByTime(0); }); expect(document.activeElement).toBe(pill);
});
it("bumps only inserted rows in SWR and follows authoritative revalidation after remount", async () => {
  const view = mount(); await act(async () => {});
  act(() => h.immediate["games:changed"]({ count: 10, inserted: 0 })); expect(screen.getByRole("button", { name: /12,345 games/ })).toBeTruthy();
  await act(async () => { h.immediate["games:changed"]({ count: 4, inserted: 2 }); }); expect(screen.getByRole("button", { name: /12,347 games/ })).toBeTruthy();
  h.me = { ...h.me!, games: { total: 13000, latest: new Date().toISOString() } };
  await act(async () => { h.coalesced["games:changed"]({ count: 4, inserted: 2 }); }); expect(screen.getByRole("button", { name: /13,000 games/ })).toBeTruthy();
  view.unmount(); mount(); expect(screen.getByRole("button", { name: /13,000 games/ })).toBeTruthy();
});
it("keeps the authoritative played time while an older replay is imported today", async () => {
  h.me!.games.latest = "2026-10-01T12:00:00Z";
  mount(); await act(async () => {});
  await act(async () => { h.immediate["games:changed"]({ count: 1, inserted: 1 }); });
  expect(screen.getByRole("button", { name: /12,346 games · latest game 22 d ago/ })).toBeTruthy();
  expect(screen.queryByText(/last upload/i)).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: /Agent online/ }));
  expect(screen.getByRole("dialog").textContent).toContain("Latest game:");
});
it("uses exactly the150second heartbeat boundary and rejects invalid timestamps", () => {
  const now = Date.now(); expect(agentPresence(new Date(now - 149999).toISOString(), now)).toBe("online"); expect(agentPresence(new Date(now - 150000).toISOString(), now)).toBe("offline"); expect(agentPresence("bad", now)).toBe("offline"); expect(agentPresence(null, now)).toBe("offline");
});
const SEEN = "2026-10-23T11:59:30Z";
function health(overrides: Partial<SyncHealthResponse> = {}): SyncHealthResponse {
  return { checkedAt: "2026-10-23T12:00:00Z", reported: true, rejections: null, ...overrides,
    rows: overrides.rows ?? [
      { code: "agent_paused", severity: "info", count: 2, deviceId: "pc-1", helpSlug: "desktop-app-status", fix: "resume" },
      { code: "replays_skipped_unresolved", severity: "warn", count: 7, deviceId: "pc-1", helpSlug: "my-game-didnt-show-up", fix: "add_identity" },
      { code: "agent_upload_failing", severity: "error", count: 4, deviceId: "pc-2", helpSlug: "desktop-app-status", fix: "retry" },
      { code: "uploads_rejected", severity: "warn", count: 3, helpSlug: "my-game-didnt-show-up", fix: "report" },
    ],
    devices: overrides.devices ?? [
      { deviceId: "pc-1", hostname: "GAMING-PC", lastSeenAt: SEEN, reported: true, syncReportedAt: SEEN, sync: { paused: true, pending: 2, skipped: { player_unresolved: 7 }, unresolvedNames: [{ name: "RivalName", toonHandle: "1-S2-1-424242", count: 7 }] } },
      { deviceId: "pc-2", label: "Laptop", lastSeenAt: SEEN, reported: true, syncReportedAt: SEEN, sync: { pending: 4, lastErrorCode: "network_timeout" } },
    ] };
}
async function openDetails() {
  fireEvent.click(screen.getByRole("button", { name: /Agent online/ }));
  await act(async () => {});
  return screen.getByRole("dialog", { name: "Desktop app details" });
}
it("reads sync health only once its details open, then lists the top count-only reasons and its help", async () => {
  h.health = health(); mount(); await act(async () => {});
  expect(h.fetched).not.toHaveBeenCalledWith("/v1/me/sync-health");
  const dialog = await openDetails();
  expect(within(dialog).getByText("Uploads are failing.")).toBeTruthy();
  expect(h.fetched).toHaveBeenCalledWith("/v1/me/sync-health");
  // One read when shown: no polling and no focus or reconnect refresh.
  expect(h.configs["/v1/me/sync-health"]).toEqual({ revalidateOnFocus: false, revalidateOnReconnect: false });
  const text = dialog.textContent ?? "";
  expect(text).toContain("Sync health: 3 things need attention");
  expect(text).toContain("The desktop app can't upload 4 games.");
  expect(text).toContain("7 replays were skipped because the desktop app couldn't tell which player is you.");
  expect(text).toContain("1 more in Sync health.");
  expect(text).not.toContain("Syncing is paused");
  // The pill never shows a player, a toon handle or a PC name.
  expect(text).not.toMatch(/RivalName|1-S2-1-424242|GAMING-PC|Laptop/);
  expect(within(dialog).getByRole("link", { name: "Open Sync health" }).getAttribute("href")).toBe("/settings?tab=account#sync-health");
  expect(within(dialog).getByRole("link", { name: "What the status lights mean" }).getAttribute("href")).toBe("/help/desktop-app-status");
  expect(within(dialog).getByRole("link", { name: "Why didn't my game show up?" }).getAttribute("href")).toBe("/help/my-game-didnt-show-up");
  // The status text keeps reading /v1/me alone.
  expect(screen.getByRole("button", { name: /Agent online · 12,345 games/ })).toBeTruthy();
});
it("says when the desktop app version doesn't report sync health yet", async () => {
  h.health = health({ reported: false, rows: [], devices: [{ deviceId: "pc-1", hostname: "GAMING-PC", agentVersion: "0.24.8", lastSeenAt: SEEN, reported: false }] });
  mount(); await act(async () => {});
  const dialog = await openDetails();
  expect(dialog.textContent).toContain("Sync health: Sync health not reported");
  expect(dialog.textContent).toContain("This desktop app version doesn't report sync health yet.");
});
it("closes from Open Sync health and keeps its other details when the read fails", async () => {
  h.health = health(); let view = mount(); await act(async () => {});
  let dialog = await openDetails();
  fireEvent.click(within(dialog).getByRole("link", { name: "Open Sync health" }));
  expect(screen.queryByRole("dialog")).toBeNull();
  view.unmount(); cache = new Map(); h.health = new Error("offline");
  view = mount(); await act(async () => {});
  dialog = await openDetails();
  expect(within(dialog).getByText(/Couldn't check sync health/)).toBeTruthy();
  expect(within(dialog).getByRole("button", { name: "Retry" })).toBeTruthy();
  expect(within(dialog).getByRole("link", { name: "Open Devices" })).toBeTruthy();
});
