import { useSyncExternalStore } from "react";
import { vi } from "vitest";

const listeners = new Set<() => void>();
const subscribe = (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener); }; };
export const navigation = { url: "/admin/users", visit(url: string) { this.url = url; for (const listener of listeners) listener(); } };
const snapshot = () => navigation.url;
export const router = { replace: vi.fn((url: string) => navigation.visit(url)), push: vi.fn((url: string) => navigation.visit(url)) };
export function usePathname() { return useSyncExternalStore(subscribe, snapshot, snapshot).split("?")[0]; }
export function useSearchParams() { return new URLSearchParams(useSyncExternalStore(subscribe, snapshot, snapshot).split("?")[1] || ""); }
export const useRouter = () => router;
