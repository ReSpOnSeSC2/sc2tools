import { useSyncExternalStore } from "react";
import { vi } from "vitest";
const EVENT = "replay-fixture-navigation";
const subscribe = (notify: () => void) => { window.addEventListener(EVENT, notify); window.addEventListener("popstate", notify); return () => { window.removeEventListener(EVENT, notify); window.removeEventListener("popstate", notify); }; };
export function visit(href: string, back = false) { window.history.replaceState(window.history.state, "", href); window.dispatchEvent(new Event(back ? "popstate" : EVENT)); }
export const navigation = { hold: false, pending: [] as string[], acknowledge() { const next = this.pending.shift(); if (next) visit(next); } };
const write = (href: string, push: boolean) => { if (navigation.hold) navigation.pending.push(href); else { window.history[push ? "pushState" : "replaceState"](window.history.state, "", href); window.dispatchEvent(new Event(EVENT)); } };
export const router = { replace: vi.fn((href: string) => write(href, false)), push: vi.fn((href: string) => write(href, true)) };
export const useRouter = () => router;
export const usePathname = () => useSyncExternalStore(subscribe, () => window.location.pathname, () => "/app/replays");
export const useSearchParams = () => new URLSearchParams(useSyncExternalStore(subscribe, () => window.location.search, () => ""));
