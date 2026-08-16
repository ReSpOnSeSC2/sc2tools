import type { ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";

const route = vi.hoisted(() => ({
  pathname: "/app" as string | null,
  clerkRenders: vi.fn(),
}));

vi.mock("next/navigation", () => ({
  usePathname: () => route.pathname,
}));

vi.mock("@clerk/nextjs", () => ({
  ClerkProvider: ({ children }: { children: ReactNode }) => {
    route.clerkRenders();
    return <div data-testid="clerk-provider">{children}</div>;
  },
}));

vi.mock("@/components/ui/Toast", () => ({
  ToastProvider: ({ children }: { children: ReactNode }) => (
    <div data-testid="toast-provider">{children}</div>
  ),
}));

vi.mock("@/components/chrome/Header", () => ({
  Header: () => <header data-testid="site-header" />,
}));

vi.mock("@/components/chrome/Footer", () => ({
  Footer: () => <footer data-testid="site-footer" />,
}));

vi.mock("@/components/CookieBanner", () => ({
  CookieBanner: () => <div data-testid="cookie-banner" />,
}));

vi.mock("@/components/analytics/GoogleAnalytics", () => ({
  GoogleAnalytics: () => <div data-testid="google-analytics" />,
}));

vi.mock("@/components/pwa/ServiceWorkerRegister", () => ({
  ServiceWorkerRegister: () => <div data-testid="service-worker" />,
}));

import { AppShell } from "./AppShell";

function renderAt(pathname: string | null) {
  route.pathname = pathname;
  return render(
    <AppShell>
      <div data-testid="route-content" />
    </AppShell>,
  );
}

afterEach(() => {
  cleanup();
  route.pathname = "/app";
  route.clerkRenders.mockClear();
});

describe("token-auth broadcast routes", () => {
  it.each([
    "/overlay",
    "/overlay/public-token",
    "/overlay/public-token/scene/starting-soon",
    "/dock",
    "/dock/public-token",
  ])("renders %s without Clerk or normal site chrome", (pathname) => {
    renderAt(pathname);

    expect(screen.getByTestId("route-content")).toBeTruthy();
    expect(screen.getByTestId("toast-provider")).toBeTruthy();
    expect(screen.queryByTestId("clerk-provider")).toBeNull();
    expect(route.clerkRenders).not.toHaveBeenCalled();
    expect(screen.queryByTestId("site-header")).toBeNull();
    expect(screen.queryByTestId("site-footer")).toBeNull();
    expect(screen.queryByTestId("cookie-banner")).toBeNull();
    expect(screen.queryByTestId("google-analytics")).toBeNull();
    expect(screen.queryByTestId("service-worker")).toBeNull();
    expect(screen.getByTestId("route-content").closest("main")).toBeTruthy();
  });
});

describe("normal and protected routes", () => {
  it.each(["/", "/app", "/settings", "/overlay-tools", "/dockyard"])(
    "keeps Clerk and the complete site shell on %s",
    (pathname) => {
      renderAt(pathname);

      expect(screen.getByTestId("clerk-provider")).toBeTruthy();
      expect(route.clerkRenders).toHaveBeenCalledTimes(1);
      expect(screen.getByTestId("site-header")).toBeTruthy();
      expect(screen.getByTestId("site-footer")).toBeTruthy();
      expect(screen.getByTestId("cookie-banner")).toBeTruthy();
      expect(screen.getByTestId("google-analytics")).toBeTruthy();
      expect(screen.getByTestId("service-worker")).toBeTruthy();
      expect(screen.getByTestId("route-content")).toBeTruthy();
    },
  );

  it("fails closed to Clerk when the pathname is temporarily unavailable", () => {
    renderAt(null);

    expect(screen.getByTestId("clerk-provider")).toBeTruthy();
    expect(route.clerkRenders).toHaveBeenCalledTimes(1);
  });
});
