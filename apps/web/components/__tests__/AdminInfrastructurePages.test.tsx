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

const INFRASTRUCTURE = {
  asOf: "2026-08-11T17:02:00.000Z",
  overallStatus: "watch",
  providers: {
    cloudflare: {
      configured: true,
      available: true,
      stale: false,
      status: "healthy",
      measuredAt: "2026-08-11T16:40:00.000Z",
      errorCode: null,
      usage: {
        verifiedOriginalReplays: 6_567,
        storedBytes: 626_577_971,
        objectCount: 13_134,
        includes: "originals_and_analysis",
        billingCycleStart: "2026-08-01T00:00:00.000Z",
        classARequests: 42_000,
        classBRequests: 107_000,
        unknownRequests: 0,
      },
      cost: {
        currency: "USD",
        estimate: true,
        storageMonthlyRunRateUsd: 0.04,
        classAThisCycleUsd: 0.01,
        classBThisCycleUsd: 0,
        estimatedCurrentMonthlyUsd: 0.05,
      },
    },
    mongo: {
      configured: true,
      available: true,
      monitoringAvailable: true,
      stale: false,
      status: "watch",
      measuredAt: "2026-08-11T17:01:00.000Z",
      errorCode: null,
      appData: {
        logicalDataBytes: 3_000_000_000,
        allocatedDocumentBytes: 3_500_000_000,
        allocatedIndexBytes: 454_452_070,
        allocatedTotalBytes: 3_954_452_070,
        scope: "sc2tools_database_only",
        measuredAt: "2026-08-11T17:00:00.000Z",
      },
      cluster: {
        tier: "m10",
        provisionedDiskGb: 10,
        diskUsedBytes: 3_954_452_070,
        diskCapacityBytes: 10_632_560_640,
        diskUtilizationPercent: 37.2,
        diskMeasuredAt: "2026-08-11T16:55:00.000Z",
        autoExpandStorage: true,
        performance: {
          scope: "cluster_electable_processes_worst_case",
          processCount: 2,
          expectedProcessCount: 3,
          complete: false,
          windowMinutes: 60,
          sustainedWindowMinutes: 15,
          measuredAt: "2026-08-11T16:55:00.000Z",
          cpu: {
            averagePercent: 22.5,
            peakPercent: 44.1,
            latestPercent: 20.2,
            sampleCount: 12,
          },
          cache: {
            averagePercent: 58.1,
            peakPercent: 70.4,
            latestPercent: 59.2,
            sampleCount: 12,
          },
          connections: {
            average: 12,
            peak: 18,
            latest: 14,
            sampleCount: 12,
          },
        },
      },
      credential: {
        expiresAt: "2026-08-23T00:00:00.000Z",
        daysRemaining: 12,
        expiringSoon: true,
      },
      cost: {
        currency: "USD",
        estimate: true,
        pricingMode: "atlas_projected",
        planningMonthlyUsd: 56.94,
        projectedMonthlyUsd: 88.63,
        postedCycleUsd: 28.59,
        postedThrough: "2026-08-10T00:00:00.000Z",
      },
    },
    render: {
      configured: true,
      available: true,
      stale: false,
      status: "healthy",
      measuredAt: "2026-08-11T16:58:00.000Z",
      errorCode: null,
      service: {
        plan: "starter",
        instanceCount: 1,
        suspended: false,
        autoscalingEnabled: false,
      },
      metrics: {
        windowMinutes: 60,
        resolutionSeconds: 300,
        measuredAt: "2026-08-11T16:58:00.000Z",
        cpu: {
          averagePercent: 18.2,
          peakPercent: 41.5,
          latestPercent: 17.9,
          sampleCount: 12,
        },
        memory: {
          averagePercent: 52.4,
          peakPercent: 61.8,
          latestPercent: 53.1,
          sampleCount: 12,
        },
      },
      cost: {
        currency: "USD",
        estimate: true,
        monthlyPlanningUsd: 7,
        basis: "operator_configured",
      },
    },
  },
  advisories: [
    {
      provider: "mongo",
      level: "watch",
      code: "atlas_credential_expiring",
      title: "Rotate the Atlas credential soon",
      message: "The Atlas service-account secret expires in 12 days.",
      action: "Create a replacement secret and update Render before monitoring stops.",
      metric: "credential_days_remaining",
      value: 12,
      threshold: 30,
    },
  ],
  thresholds: {
    mongo: {
      disk: { watch: 65, upgrade: 80 },
      cpuAverage: { watch: 60, upgrade: 75 },
      cpuPeak: { watch: 80, upgrade: 90 },
      cacheAverage: { watch: 75, upgrade: 90 },
      cachePeak: { watch: 90, upgrade: 95 },
    },
    render: {
      cpuAverage: { watch: 60, upgrade: 75 },
      cpuPeak: { watch: 80, upgrade: 90 },
      memoryAverage: { watch: 65, upgrade: 80 },
      memoryPeak: { watch: 85, upgrade: 95 },
    },
  },
} as const;

describe("admin infrastructure health", () => {
  it("shows safe R2, Mongo, Atlas billing, and credential diagnostics", () => {
    useApiMock.mockImplementation((path: string) => {
      return {
        data: path === "/v1/admin/infrastructure" ? INFRASTRUCTURE : HEALTH,
        error: null,
        isLoading: false,
      };
    });

    const { container } = render(<AdminHealthPage />);

    expect(useApiMock).toHaveBeenCalledWith("/v1/admin/health", {
      refreshInterval: 30_000,
    });
    expect(useApiMock).toHaveBeenCalledWith("/v1/admin/infrastructure", {
      refreshInterval: 5 * 60_000,
    });
    const replayStore = screen.getByText("Original replay store").closest("section");
    expect(replayStore).not.toBeNull();
    expect(within(replayStore!).getByText("Cloudflare R2")).toBeTruthy();
    const cloudflare = screen.getByRole("heading", { name: "Cloudflare R2" }).closest("section");
    expect(cloudflare).not.toBeNull();
    expect(within(cloudflare!).getByText("$0.05/mo")).toBeTruthy();
    expect(within(cloudflare!).getByText("627 MB")).toBeTruthy();
    expect(within(cloudflare!).getByText(/6,567 originals · 13,134 objects/)).toBeTruthy();

    const mongo = screen.getByRole("heading", { name: "MongoDB Atlas" }).closest("section");
    expect(mongo).not.toBeNull();
    expect(within(mongo!).getByText("M10")).toBeTruthy();
    expect(within(mongo!).getByText("37.2%")).toBeTruthy();
    expect(within(mongo!).getByText(/3.68 GiB \/ 9.90 GiB/)).toBeTruthy();
    expect(within(mongo!).getByText(/2\/3 nodes measured/)).toBeTruthy();
    expect(within(mongo!).getByText(/CPU and cache coverage is partial/)).toBeTruthy();
    expect(screen.getByText("$88.63/mo")).toBeTruthy();
    expect(within(mongo!).getByText(/\$28\.59 posted this cycle/)).toBeTruthy();

    const renderCard = screen.getByRole("heading", { name: "Render API" }).closest("section");
    expect(renderCard).not.toBeNull();
    expect(within(renderCard!).getByText("Starter")).toBeTruthy();
    expect(within(renderCard!).getByText("$7.00/mo")).toBeTruthy();

    expect(screen.getByText("Rotate the Atlas credential soon")).toBeTruthy();
    expect(screen.getByText(/12 days observed · 30 days watch line/)).toBeTruthy();
    expect(screen.getByText(/not final invoices/i)).toBeTruthy();

    const rendered = container.textContent || "";
    expect(rendered).not.toContain("must-never-render");
    expect(rendered).not.toContain("hidden.example.test");
  });

  it("labels stale and unavailable provider values instead of inventing them", () => {
    useApiMock.mockImplementation((path: string) => {
      if (path === "/v1/admin/infrastructure") {
        return {
          data: {
            ...INFRASTRUCTURE,
            providers: {
              cloudflare: {
                ...INFRASTRUCTURE.providers.cloudflare,
                stale: true,
              },
              mongo: {
                ...INFRASTRUCTURE.providers.mongo,
                monitoringAvailable: false,
                cluster: null,
                cost: {
                  ...INFRASTRUCTURE.providers.mongo.cost,
                  pricingMode: "planning_fallback",
                  projectedMonthlyUsd: null,
                  postedCycleUsd: null,
                  postedThrough: null,
                },
              },
              render: {
                ...INFRASTRUCTURE.providers.render,
                available: false,
                service: null,
                metrics: null,
                cost: null,
              },
            },
          },
          error: null,
          isLoading: false,
        };
      }
      return { data: HEALTH, error: null, isLoading: false };
    });

    render(<AdminHealthPage />);

    const cloudflare = screen.getByRole("heading", { name: "Cloudflare R2" }).closest("section");
    expect(cloudflare).not.toBeNull();
    expect(within(cloudflare!).getByText("Stale")).toBeTruthy();
    expect(within(cloudflare!).getByText(/Last-good snapshot/)).toBeTruthy();

    const mongo = screen.getByRole("heading", { name: "MongoDB Atlas" }).closest("section");
    expect(mongo).not.toBeNull();
    expect(within(mongo!).getByText("$56.94/mo")).toBeTruthy();
    expect(within(mongo!).getByText(/Atlas capacity monitoring unavailable/)).toBeTruthy();

    const renderCard = screen.getByRole("heading", { name: "Render API" }).closest("section");
    expect(renderCard).not.toBeNull();
    expect(within(renderCard!).getAllByText("Unavailable").length).toBeGreaterThan(0);
    expect(within(renderCard!).getByText("Live provider metrics unavailable")).toBeTruthy();
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
