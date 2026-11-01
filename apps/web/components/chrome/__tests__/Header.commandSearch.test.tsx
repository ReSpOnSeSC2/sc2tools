import { cleanup, render, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import type { AnchorHTMLAttributes, ReactNode } from "react";
import { CommandSearchContext, type CommandChrome } from "../CommandSearchContext";

const state = vi.hoisted(() => ({ audience: "in" as "in" | "out", me: undefined as { isAdmin?: boolean } | undefined }));
vi.mock("next/navigation", () => ({ usePathname: () => "/help", useSearchParams: () => new URLSearchParams() }));
vi.mock("next/link", () => ({ default: ({ children, ...props }: AnchorHTMLAttributes<HTMLAnchorElement>) => <a {...props}>{children}</a> }));
vi.mock("@clerk/nextjs", () => ({
  SignedIn: ({ children }: { children: ReactNode }) => state.audience === "in" ? children : null,
  SignedOut: ({ children }: { children: ReactNode }) => state.audience === "out" ? children : null,
  UserButton: Object.assign(() => null, { MenuItems: () => null, Action: () => null }),
}));
vi.mock("@/lib/clientApi", () => ({ useApi: () => ({ data: state.me }) }));
vi.mock("@/components/ui/ThemeToggle", () => ({ ThemeToggle: () => null }));
vi.mock("@/components/ui/ThemeChoice", () => ({ ThemeDialog: () => null }));
vi.mock("../CoachingBookingAlert", () => ({ CoachingBookingAlert: () => null }));
vi.mock("@/components/notifications/NotificationBell", () => ({ NotificationBell: () => null }));
vi.mock("../MobileNav", () => ({ MobileNav: () => null }));
vi.mock("../LogoMark", () => ({ LogoMark: () => null }));
import { Header } from "../Header";

function renderWith(ownerKey: string | null) {
  const registered: CommandChrome[] = [];
  const value = { ownerKey, open: vi.fn(), registerSettings: () => () => undefined,
    registerChrome: (config: CommandChrome) => { registered.push(config); return () => undefined; } };
  const view = render(<CommandSearchContext.Provider value={value}><Header /></CommandSearchContext.Provider>);
  return { registered, view };
}
const keys = (config: CommandChrome | undefined) => config?.navigation.map((row) => row.key) ?? [];

afterEach(() => { cleanup(); state.audience = "in"; state.me = undefined; });

it("registers the header links under app keys at once, then the app's own sections for a signed-in viewer", async () => {
  const { registered, view } = renderWith("user_a");
  expect(keys(registered[0])).toContain("builds-library");
  expect(keys(registered[0])).not.toContain("today");
  await waitFor(() => expect(keys(registered.at(-1))).toEqual(expect.arrayContaining(["today", "opponents", "sessions", "help"])));
  const count = registered.length;
  view.rerender(<CommandSearchContext.Provider value={{ ownerKey: "user_a", open: vi.fn(), registerSettings: () => () => undefined,
    registerChrome: (config: CommandChrome) => { registered.push(config); return () => undefined; } }}><Header /></CommandSearchContext.Provider>);
  // A new context value re-registers the same stable config; nothing else re-registers on render.
  expect(registered.length).toBe(count + 1);
  expect(registered.at(-1)).toBe(registered.at(-2));
});

it("keeps a visitor on the header's public links, without loading the app's list", async () => {
  state.audience = "out";
  const { registered } = renderWith(null);
  expect(keys(registered[0])).toEqual(expect.arrayContaining(["stream-studio-page", "community", "help", "download"]));
  await new Promise((resolve) => setTimeout(resolve, 20));
  expect(registered.every((config) => !keys(config).includes("today"))).toBe(true);
});
