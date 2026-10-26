import { act, cleanup, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import type { AnchorHTMLAttributes, ReactNode } from "react";

const state = vi.hoisted(() => ({
  audience: "out" as "out" | "in" | "loading",
  pathname: "/guides/pvz",
  query: "map=Lockdown",
  pending: null as Promise<void> | null,
}));
vi.mock("next/navigation", () => ({
  usePathname: () => state.pathname,
  useSearchParams: () => { if (state.pending) throw state.pending; return new URLSearchParams(state.query); },
}));
vi.mock("next/link", () => ({ default: ({ children, ...props }: AnchorHTMLAttributes<HTMLAnchorElement>) => <a {...props}>{children}</a> }));
vi.mock("@clerk/nextjs", () => ({
  SignedIn: ({ children }: { children: ReactNode }) => state.audience === "in" ? children : null,
  SignedOut: ({ children }: { children: ReactNode }) => state.audience === "out" ? children : null,
  UserButton: Object.assign(() => null, { MenuItems: () => null, Action: () => null }),
}));
vi.mock("@/lib/clientApi", () => ({ useApi: () => ({ data: undefined }) }));
vi.mock("@/components/ui/ThemeToggle", () => ({ ThemeToggle: () => null }));
vi.mock("@/components/ui/ThemeChoice", () => ({ ThemeDialog: () => null }));
vi.mock("../CoachingBookingAlert", () => ({ CoachingBookingAlert: () => null }));
vi.mock("@/components/notifications/NotificationBell", () => ({ NotificationBell: () => null }));
vi.mock("../MobileNav", () => ({ MobileNav: () => null }));
vi.mock("../LogoMark", () => ({ LogoMark: () => null }));
import { Header } from "../Header";

afterEach(() => {
  cleanup(); state.audience = "out"; state.pathname = "/guides/pvz";
  state.query = "map=Lockdown"; state.pending = null;
});

it("retains the live public path and query in both desktop auth destinations", () => {
  const view = render(<Header />);
  for (const [name, route] of [["Sign in", "sign-in"], ["Get started", "sign-up"]]) {
    const link = screen.getByRole("link", { name });
    expect(link.getAttribute("href")).toBe(`/${route}?redirect_url=%2Fguides%2Fpvz%3Fmap%3DLockdown`);
  }
  state.pathname = "/community/public-build"; state.query = "matchup=PvT";
  view.rerender(<Header />);
  expect(screen.getByRole("link", { name: "Get started" }).getAttribute("href"))
    .toBe("/sign-up?redirect_url=%2Fcommunity%2Fpublic-build%3Fmatchup%3DPvT");
  expect(screen.queryByRole("link", { name: "Open app" })).toBeNull();
});

it("keeps unsupported private return destinations out of auth URLs", () => {
  state.pathname = "/app/opponents"; state.query = "opponent=private";
  render(<Header />);
  expect(screen.getByRole("link", { name: "Sign in" }).getAttribute("href")).toBe("/sign-in");
  expect(screen.getByRole("link", { name: "Get started" }).getAttribute("href")).toBe("/sign-up");
});

it("keeps usable styled auth fallback links while search parameters suspend", async () => {
  let release!: () => void;
  state.pending = new Promise<void>(resolve => { release = resolve; });
  render(<Header />);
  const fallback = screen.getByRole("link", { name: "Get started" });
  expect(fallback.getAttribute("href")).toBe("/sign-up");
  expect(fallback.classList.contains("h-9")).toBe(true);
  await act(async () => { state.pending = null; release(); });
  expect(screen.getByRole("link", { name: "Get started" }).getAttribute("href"))
    .toBe("/sign-up?redirect_url=%2Fguides%2Fpvz%3Fmap%3DLockdown");
});

it("gives signed-in players one Open app anchor with no visitor auth CTA", () => {
  state.audience = "in"; render(<Header />);
  const link = screen.getByRole("link", { name: "Open app" });
  expect(link.getAttribute("href")).toBe("/app");
  expect(link.tagName).toBe("A"); expect(link.querySelector("button,a")).toBeNull();
  expect(screen.queryByRole("link", { name: "Sign in" })).toBeNull();
  expect(screen.queryByRole("link", { name: "Get started" })).toBeNull();
});

it("keeps both audiences' action links hidden while authentication is loading", () => {
  state.audience = "loading"; render(<Header />);
  for (const name of ["Sign in", "Get started", "Open app"]) {
    expect(screen.queryByRole("link", { name })).toBeNull();
  }
});
