/**
 * OnboardingChecklist — the browser-import visibility rule and the
 * "or import in your browser" alternative on the download row. Clerk,
 * apiCall and the import status hook are mocked.
 */
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { OnboardingChecklist, checklistVisible, type ChecklistMe } from "./OnboardingChecklist";

vi.mock("@clerk/nextjs", () => ({ useAuth: () => ({ getToken: async () => "token" }) }));
vi.mock("@/lib/clientApi", () => ({ apiCall: vi.fn() }));
vi.mock("@/components/imports/useImportStatus", () => ({
  useImportStatus: () => ({ job: null, active: false, pct: 0, etaSeconds: null, isLoading: false, refresh: vi.fn() }),
}));

const BASE: ChecklistMe = { games: { total: 0 }, agentPaired: false };

afterEach(cleanup);

describe("checklistVisible with browser import", () => {
  it("keeps the old rule when the option is absent or off", () => {
    const withGames = { ...BASE, games: { total: 5 } };
    expect(checklistVisible(withGames)).toBe(true);
    expect(checklistVisible(withGames, { browserImportEnabled: false })).toBe(true);
  });

  it("hides once games exist, even without an agent", () => {
    expect(checklistVisible({ ...BASE, games: { total: 5 } }, { browserImportEnabled: true })).toBe(false);
    expect(checklistVisible(BASE, { browserImportEnabled: true })).toBe(true);
  });
});

describe("OnboardingChecklist download row", () => {
  it("offers browser import next to the download when enabled", () => {
    render(<OnboardingChecklist me={BASE} browserImportEnabled />);
    expect(screen.getByRole("link", { name: /download/i }).getAttribute("href")).toBe("/download");
    expect(screen.getByRole("link", { name: "or import in your browser" }).getAttribute("href")).toBe(
      "/settings?tab=import",
    );
  });

  it("does not mention browser import when disabled", () => {
    render(<OnboardingChecklist me={BASE} />);
    expect(screen.queryByRole("link", { name: "or import in your browser" })).toBeNull();
  });

  it("keeps the original download markup (no extra wrapper) when disabled", () => {
    render(<OnboardingChecklist me={BASE} />);
    const offParent = screen.getByRole("link", { name: /download/i }).parentElement;
    cleanup();
    render(<OnboardingChecklist me={BASE} browserImportEnabled />);
    const onParent = screen.getByRole("link", { name: /download/i }).parentElement;
    expect(onParent?.className).toContain("items-end");
    expect(offParent?.className ?? "").not.toContain("items-end");
  });

  it("keeps the browser link after the download started, until games arrive", () => {
    const started: ChecklistMe = { ...BASE, onboarding: { downloadStartedAt: "2026-09-01T00:00:00Z" } };
    render(<OnboardingChecklist me={started} browserImportEnabled />);
    expect(screen.queryByRole("link", { name: /^download$/i })).toBeNull();
    expect(screen.getByRole("link", { name: "or import in your browser" })).toBeTruthy();
    cleanup();
    render(<OnboardingChecklist me={{ ...started, agentPaired: true }} browserImportEnabled />);
    expect(screen.getByRole("link", { name: "or import in your browser" })).toBeTruthy();
  });

  it("renders nothing for a browser-only player with games", () => {
    render(<OnboardingChecklist me={{ ...BASE, games: { total: 3 } }} browserImportEnabled />);
    expect(screen.queryByTestId("onboarding-checklist")).toBeNull();
  });
});
