import { useSyncExternalStore } from "react";
import { vi } from "vitest";

const listeners = new Set<() => void>();
const subscribe = (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener); }; };
function commit(url: string, push = false) { navigation.url = url; window.history[push ? "pushState" : "replaceState"]({}, "", url); for (const listener of listeners) listener(); }
function submit(url: string, push = false) { if (navigation.defer) navigation.queued.push({ url, push }); else commit(url, push); }
export const navigation = { url: "/admin/users", defer: false, queued: [] as Array<{ url: string; push: boolean }>,
  visit(url: string) { window.history.replaceState({}, "", url); window.dispatchEvent(new PopStateEvent("popstate")); commit(url); },
  acknowledge() { const next = this.queued.shift(); if (next) commit(next.url, next.push); },
};
const snapshot = () => navigation.url;
export const router = { replace: vi.fn((url: string) => submit(url)), push: vi.fn((url: string) => submit(url, true)) };
export function usePathname() { return useSyncExternalStore(subscribe, snapshot, snapshot).split("?")[0]; }
export function useSearchParams() { return new URLSearchParams(useSyncExternalStore(subscribe, snapshot, snapshot).split("?")[1] || ""); }
export const useRouter = () => router;
