import type { ReactNode } from "react";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { SWRConfig, type Cache } from "swr";
const h = vi.hoisted(() => ({ me: undefined as undefined | { agentPaired: boolean; agentLastSeenAt: string | null; games: { total: number; latest: string | null } }, immediate: {} as Record<string, (value?: unknown) => void>, coalesced: {} as Record<string, (value?: unknown) => void>, fetched: vi.fn(), live: vi.fn() }));
vi.mock("@/lib/clientApi", async () => { const { default: useSWR } = await import("swr"); return { useApi: () => useSWR("/v1/me", async () => { h.fetched(); return h.me; }, { fallbackData: h.me, dedupingInterval: 0 }) }; });
vi.mock("@/components/realtime/RealtimeProvider", () => ({ useRealtimeState: (handlers: typeof h.immediate) => { h.immediate = handlers; return { status: "connected", attempts: 0, bulk: false }; }, useRealtimeEvents: (handlers: typeof h.coalesced) => { h.coalesced = handlers; } }));
vi.mock("@/lib/useLiveGame", () => ({ useLiveGame: h.live }));
import { AgentSyncPill } from "../SyncStatus";
import { agentPresence } from "@/lib/agentPresence";
let cache: Cache;
beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(new Date("2026-10-23T12:00:00Z")); h.fetched.mockClear(); h.live.mockClear(); cache = new Map(); h.me = { agentPaired: true, agentLastSeenAt: new Date().toISOString(), games: { total: 12345, latest: "2026-10-23T11:58:00Z" } }; });
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
  expect(screen.queryByRole("dialog")).toBeNull(); expect(document.activeElement).toBe(pill); fireEvent.click(pill); fireEvent.click(document.body); expect(screen.queryByRole("dialog")).toBeNull(); expect(document.activeElement).toBe(pill);
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
