/**
 * OnboardingImport — "browser" mode renders the compact browser import
 * panel (a MOCK stub here) and the dashboard exit; "agent" mode keeps the
 * one-click agent import. Router, Clerk and import status are mocked.
 */
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { BrowserImportPanelProps } from "@/components/instant/BrowserImportPanel";
import { OnboardingImport } from "./OnboardingImport";

const mocks = vi.hoisted(() => ({ push: vi.fn(), panelProps: [] as BrowserImportPanelProps[] }));

vi.mock("next/navigation", () => ({ useRouter: () => ({ push: mocks.push }) }));
vi.mock("@clerk/nextjs", () => ({ useAuth: () => ({ getToken: async () => "token" }) }));
vi.mock("@/lib/clientApi", () => ({ apiCall: vi.fn() }));
vi.mock("@/components/imports/useImportStatus", () => ({
  useImportStatus: () => ({ job: null, active: false, pct: 0, etaSeconds: null, isLoading: false, refresh: vi.fn() }),
}));
vi.mock("@/components/instant/BrowserImportPanel", () => ({
  BrowserImportPanel: (props: BrowserImportPanelProps) => {
    mocks.panelProps.push(props);
    return <div data-testid="browser-import-panel" />;
  },
}));

afterEach(() => {
  cleanup();
  mocks.push.mockReset();
  mocks.panelProps = [];
});

describe("OnboardingImport", () => {
  it("imports in the browser in browser mode", () => {
    render(<OnboardingImport mode="browser" />);
    expect(screen.getByTestId("browser-import-panel")).toBeTruthy();
    expect(mocks.panelProps.at(-1)?.compact).toBe(true);
    expect(screen.queryByRole("button", { name: "Import my replay history" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Open your dashboard →" }));
    expect(mocks.push).toHaveBeenCalledWith("/app");
  });

  it("keeps the agent import by default", () => {
    render(<OnboardingImport />);
    expect(screen.getByRole("button", { name: "Import my replay history" })).toBeTruthy();
    expect(screen.queryByTestId("browser-import-panel")).toBeNull();
  });
});
