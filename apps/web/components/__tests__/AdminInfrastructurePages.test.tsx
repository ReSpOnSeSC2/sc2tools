import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, within } from "@testing-library/react";
import AdminDashboardPage from "@/app/admin/page";
import AdminHealthPage from "@/app/admin/health/page";

const useApiMock = vi.fn();

vi.mock("@/lib/clientApi", () => ({
  useApi: (...args: unknown[]) => useApiMock(...args),
}));

vi.mock("@/app/admin/components/useAdminEventsSocket", () => ({
  useAdminEventsSocket: () => undefined,
}));

afterEach(() => {
  cleanup();
  useApiMock.mockReset();
});

const HEALTH = {
  mongo: {
    ok: true,
    latencyMs: 12,
    error: null,
    storage: {
      logicalDataBytes: 3_000_000_000,
      allocatedDocumentBytes: 3_500_000_000,
      allocatedIndexBytes: 454_452_070,
      allocatedTotalBytes: 3_954_452_070,
      scope: "sc2tools_database_only",
      measuredAt: "2026-08-11T17:00:00.000Z",
    },
    pricing: {
      monthlyPlanningEstimateUsd: 56.94,
      includedInSiteFixedMonthlyEquivalent: true,
      estimate: true,
      basis: "repo_budget_assumption",
    },
    atlas: {
      configured: true,
      available: true,
      measuredAt: "2026-08-11T17:01:00.000Z",
      cluster: {
        tier: "M10",
        provider: "GCP",
        region: "WESTERN_US",
        provisionedDiskGb: 10,
        autoExpandStorage: true,
        diskUsedBytes: 3_954_452_070,
        diskCapacityBytes: 10_632_560_640,
        diskMeasuredAt: "2026-08-11T16:55:00.000Z",
        clusterName: "must-never-render",
        hostname: "hidden.example.test",
      },
      billing: {
        available: true,
        cycleStart: "2026-08-01T00:00:00.000Z",
        cycleEnd: "2026-09-01T00:00:00.000Z",
        postedThrough: "2026-08-10T00:00:00.000Z",
        postedCycleCents: 2_859,
        categoryCents: {
          compute: 2_500,
          storage: 300,
          transfer: 59,
          other: 0,
        },
        projectedMonthlyRunRateCents: 8_863,
        projectedMonthlyRunRateUsd: 88.63,
        clusterPostedGrossUsd: 30,
        clusterPostedDiscountUsd: 1.41,
        clusterPostedNetUsd: 28.59,
        lineItemCount: 8,
        currency: "USD",
        source: "atlas_pending_invoice",
        lagDaysApprox: 1,
        errorCode: null,
      },
      credential: {
        expiresAt: "2026-08-23T00:00:00.000Z",
        daysRemaining: 12,
        expiringSoon: true,
      },
      errorCode: null,
      projectId: "must-never-render-project",
    },
  },
  cloudflareAnalytics: {
    configured: true,
    available: true,
    stale: false,
    asOf: "2026-08-11T16:40:00.000Z",
    errorCode: null,
    accountId: "must-never-render-account",
  },
  uptime: {
    startedAt: "2026-08-11T12:00:00.000Z",
    uptimeSeconds: 18_000,
  },
  runtime: {
    nodeVersion: "v22.1.0",
    gameDetailsStore: "r2",
    replayFilesStore: "r2",
    infrastructureCostsConfigured: true,
  },
} as const;

describe("admin infrastructure health", () => {
  it("shows safe R2, Mongo, Atlas billing, and credential diagnostics", () => {
    useApiMock.mockReturnValue({
      data: HEALTH,
      error: null,
      isLoading: false,
    });

    const { container } = render(<AdminHealthPage />);

    expect(useApiMock).toHaveBeenCalledWith("/v1/admin/health", {
      refreshInterval: 30_000,
    });
    const replayStore = screen.getByText("Original replay store").closest("section");
    expect(replayStore).not.toBeNull();
    expect(within(replayStore!).getByText("Cloudflare R2")).toBeTruthy();
    expect(screen.getByText(/Latest aggregate snapshot/i)).toBeTruthy();
    expect(screen.getByText("3.68 GiB / 9.90 GiB")).toBeTruthy();
    expect(screen.getByText("$28.59")).toBeTruthy();
    expect(screen.getByText("$88.63/mo")).toBeTruthy();
    expect(screen.getByText(/about 1d lag/i)).toBeTruthy();
    expect(screen.getByText(/not a final invoice/i)).toBeTruthy();
    expect(screen.getByRole("alert").textContent).toContain("12 days remaining");
    expect(screen.getByText(/final invoice remain authoritative/i)).toBeTruthy();

    const rendered = container.textContent || "";
    expect(rendered).not.toContain("must-never-render");
    expect(rendered).not.toContain("hidden.example.test");
  });

  it("labels stale and unavailable provider values instead of inventing them", () => {
    useApiMock.mockReturnValue({
      data: {
        ...HEALTH,
        cloudflareAnalytics: {
          ...HEALTH.cloudflareAnalytics,
          stale: true,
          errorCode: "stale_last_good",
        },
        mongo: {
          ...HEALTH.mongo,
          atlas: {
            ...HEALTH.mongo.atlas,
            cluster: {
              ...HEALTH.mongo.atlas.cluster,
              diskUsedBytes: null,
              diskCapacityBytes: null,
              diskMeasuredAt: null,
            },
            billing: {
              ...HEALTH.mongo.atlas.billing,
              available: false,
              postedCycleCents: null,
              categoryCents: null,
              projectedMonthlyRunRateCents: null,
              projectedMonthlyRunRateUsd: null,
              errorCode: "atlas_billing_unavailable",
            },
          },
        },
      },
      error: null,
      isLoading: false,
    });

    render(<AdminHealthPage />);

    expect(screen.getByText("stale snapshot")).toBeTruthy();
    expect(screen.getByText(/Last-good aggregate snapshot/i)).toBeTruthy();
    expect(screen.getByText(/Provider disk metric unavailable; no value inferred/i)).toBeTruthy();
    expect(screen.getByText("Pending-invoice charges unavailable")).toBeTruthy();
  });
});

describe("admin dashboard storage", () => {
  it("separates whole app dbStats and the planning estimate from collections", () => {
    useApiMock.mockImplementation((path: string) => {
      if (path === "/v1/admin/events/counts") {
        return {
          data: {
            totalUsers: 2,
            signupsToday: 0,
            signupsThisWeek: 1,
            totalSignupsTracked: 2,
            totalDownloads: 3,
            downloadsToday: 0,
            downloadsThisWeek: 1,
            downloadsByPlatform: { windows: 3, macos: 0, linux: 0 },
            unreadCount: 0,
            agents: { total: 1, active24h: 1, active7d: 1 },
            generatedAt: "2026-08-11T17:00:00.000Z",
          },
          error: null,
          isLoading: false,
          mutate: vi.fn(),
        };
      }
      if (path.startsWith("/v1/admin/events?")) {
        return {
          data: { items: [], nextBefore: null },
          error: null,
          isLoading: false,
        };
      }
      return {
        data: {
          totalDocs: 10,
          totalDataBytes: 4_000_000,
          totalStorageBytes: 3_000_000,
          totalIndexBytes: 500_000,
          collections: [
            {
              name: "games",
              count: 10,
              avgObjSize: 400_000,
              storageSize: 3_000_000,
              totalSize: 4_000_000,
              indexSize: 500_000,
            },
          ],
          database: {
            available: true,
            appData: {
              logicalDataBytes: 5_500_000,
              allocatedDocumentBytes: 4_000_000,
              allocatedIndexBytes: 500_000,
              allocatedTotalBytes: 4_500_000,
              scope: "sc2tools_database_only",
              measuredAt: "2026-08-11T17:00:00.000Z",
            },
            pricing: {
              monthlyPlanningEstimateUsd: 56.94,
              includedInSiteFixedMonthlyEquivalent: true,
              estimate: true,
              basis: "repo_budget_assumption",
            },
          },
        },
        error: null,
        isLoading: false,
      };
    });

    render(<AdminDashboardPage />);

    expect(screen.getByText("Application database footprint")).toBeTruthy();
    expect(screen.getByText("5.50 MB")).toBeTruthy();
    expect(screen.getByText("4.50 MB")).toBeTruthy();
    expect(screen.getByText("$56.94/mo")).toBeTruthy();
    expect(screen.getByText(/repository estimate, not an Atlas invoice/i)).toBeTruthy();
    expect(screen.getByText(/not Atlas disk capacity/i)).toBeTruthy();
    expect(screen.getByText("Tracked collection totals")).toBeTruthy();
  });
});
