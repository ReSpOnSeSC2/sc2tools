import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import type { ReactNode } from "react";
import { DashboardLayout } from "../DashboardLayout";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: vi.fn() }),
}));
vi.mock("@/lib/clientApi", () => ({
  useApi: () => ({ data: { defaultTab: "macro" } }),
}));
vi.mock("@/lib/useUserSocket", () => ({ useUserSocket: () => undefined }));
vi.mock("@/components/analyzer/AnalyzerShell", () => ({
  AnalyzerShell: ({
    tab,
    initialOpponentId,
  }: {
    tab: string;
    initialOpponentId?: string | null;
  }) => <div>{`Analyzer ${tab} ${initialOpponentId || "none"}`}</div>,
}));
vi.mock("@/components/analyzer/MobileSectionPicker", () => ({
  MobileSectionPicker: () => null,
}));
vi.mock("@/components/SyncStatus", () => ({ SyncStatus: () => null }));
vi.mock("@/components/dashboard/LiveGamePanel", () => ({
  LiveGamePanel: () => null,
}));
vi.mock("@/components/ui/ErrorBoundary", () => ({
  ErrorBoundary: ({ children }: { children: ReactNode }) => <>{children}</>,
}));
vi.mock("@/components/onboarding/OnboardingChecklist", () => ({
  OnboardingChecklist: () => null,
  checklistVisible: () => false,
}));
vi.mock("@/components/imports/useImportStatus", () => ({
  useImportStatus: () => ({ active: false, job: null }),
}));
vi.mock("@/components/imports/ImportProgressCard", () => ({
  ImportProgressCard: () => null,
}));

afterEach(cleanup);

describe("DashboardLayout opponent backlink", () => {
  it("keeps the hydrated opponent active despite a different saved default tab", () => {
    render(
      <DashboardLayout
        me={{
          userId: "user-1",
          source: "cloud",
          games: { total: 50, latest: "2026-07-12T00:00:00Z" },
          agentPaired: true,
        }}
        initialOpponentId="1-S2-1-99"
      />,
    );

    expect(screen.getByText("Analyzer opponents 1-S2-1-99")).toBeTruthy();
  });
});
