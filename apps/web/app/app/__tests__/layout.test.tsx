import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

const apiHarness = vi.hoisted(() => ({
  response: { ok: false, status: 502, error: "http_502" } as Record<string, unknown>,
}));

vi.mock("@/lib/api", () => ({
  apiFetch: vi.fn(async () => apiHarness.response),
}));

vi.mock("@/components/chrome/AppChrome", () => ({
  AppChrome: ({ children }: { children: React.ReactNode }) => (
    <div>chrome loaded {children}</div>
  ),
}));

import AppLayout from "@/app/app/layout";

afterEach(() => {
  cleanup();
  apiHarness.response = { ok: false, status: 502, error: "http_502" };
});

/**
 * The /v1/me gate moved from the old dashboard page into the /app
 * layout so every routed section shares it. Same guarantees as before:
 * a 502 gets a friendly retry with no deployment internals, and an
 * expired session routes back to sign-in.
 */
describe("app layout API recovery state", () => {
  it("shows a friendly retry without deployment instructions during a 502", async () => {
    render(await resolveLayout());

    expect(screen.getByText("Dashboard temporarily unavailable")).toBeTruthy();
    expect(screen.getByText(/replay data is safe/i)).toBeTruthy();
    expect(screen.getByRole("link", { name: "Try again" }).getAttribute("href"))
      .toBe("/app");
    expect(screen.queryByText(/NEXT_PUBLIC_API_BASE/)).toBeNull();
  });

  it("directs an expired session back to sign-in", async () => {
    apiHarness.response = { ok: false, status: 401, error: "unauthorized" };
    render(await resolveLayout());

    expect(screen.getByText("Sign in again")).toBeTruthy();
    expect(screen
      .getByRole("link", { name: "Continue to sign in" })
      .getAttribute("href"))
      .toBe("/sign-in");
  });

  it("mounts the chrome around children once /v1/me resolves", async () => {
    apiHarness.response = {
      ok: true,
      status: 200,
      data: {
        userId: "u1",
        source: "cloud",
        games: { total: 3, latest: null },
        agentPaired: true,
      },
    };
    render(await resolveLayout());

    expect(screen.getByText(/chrome loaded/)).toBeTruthy();
    expect(screen.getByText("PAGE")).toBeTruthy();
  });
});

/**
 * AppLayout renders a Suspense boundary around an async inner
 * component; resolve that inner element directly so the test asserts
 * the settled UI rather than the fallback.
 */
async function resolveLayout() {
  const outer = AppLayout({ children: <div>PAGE</div> });
  const inner = outer.props.children;
  return await inner.type(inner.props);
}
