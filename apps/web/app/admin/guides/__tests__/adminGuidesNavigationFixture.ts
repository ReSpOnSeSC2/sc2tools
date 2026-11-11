import { useSyncExternalStore } from "react";
import { vi } from "vitest";

let search = "";
const listeners = new Set<() => void>();
const subscribe = (listener: () => void) => { listeners.add(listener); return () => listeners.delete(listener); };
const read = () => search;
function setSearch(next: string) { search = next; listeners.forEach(listener => listener()); }
const route = (href: string) => setSearch(new URL(href, "https://example.test").search);

export const guideNavigation = { setSearch, push: vi.fn(route), replace: vi.fn(route) };
export const guideNavigationHooks = {
  usePathname: () => "/admin/guides",
  useRouter: () => guideNavigation,
  useSearchParams: () => new URLSearchParams(useSyncExternalStore(subscribe, read, read)),
};
