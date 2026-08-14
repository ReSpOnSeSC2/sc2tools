import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

const apiHarness = vi.hoisted(() => ({
  response: { ok: false, status: 502, error: "http_502" } as Record<string, unknown>,
}));

vi.mock("@/lib/api", () => ({
  apiFetch: vi.fn(async () => apiHarness.response),
}));

vi.mock("@/components/dashboard/DashboardLayout", () => ({
  DashboardLayout: () => <div>dashboard loaded</div>,
}));

import AnalyzerHome from "@/app/app/page";

afterEach(() => {
  cleanup();
  apiHarness.response = { ok: false, status: 502, error: "http_502" };
});

describe("dashboard API recovery state", () => {
  it("shows a friendly retry without deployment instructions during a 502", async () => {
    render(await AnalyzerHome({ searchParams: Promise.resolve({}) }));

    expect(screen.getByText("Dashboard temporarily unavailable")).toBeTruthy();
    expect(screen.getByText(/replay data is safe/i)).toBeTruthy();
    expect(screen.getByRole("link", { name: "Try again" }).getAttribute("href"))
      .toBe("/app");
    expect(screen.queryByText(/NEXT_PUBLIC_API_BASE/)).toBeNull();
  });

  it("directs an expired session back to sign-in", async () => {
    apiHarness.response = { ok: false, status: 401, error: "unauthorized" };
    render(await AnalyzerHome({ searchParams: Promise.resolve({}) }));

    expect(screen.getByText("Sign in again")).toBeTruthy();
    expect(screen
      .getByRole("link", { name: "Continue to sign in" })
      .getAttribute("href"))
      .toBe("/sign-in");
  });
});
