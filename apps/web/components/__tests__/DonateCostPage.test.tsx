import { afterEach, expect, test, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";

const getInfrastructureCostsMock = vi.hoisted(() => vi.fn());

vi.mock("@/lib/infrastructureCosts", async (importOriginal) => {
  const actual = await importOriginal<
    typeof import("@/lib/infrastructureCosts")
  >();
  return {
    ...actual,
    getInfrastructureCosts: (...args: unknown[]) =>
      getInfrastructureCostsMock(...args),
  };
});

import DonatePage from "@/app/donate/page";

const COSTS = {
  asOf: "2026-08-11T16:30:00.000Z",
  stale: false,
  estimate: true,
  archive: {
    verifiedOriginalReplays: 12_345,
    r2StoredBytes: 12_340_000_000,
    r2ObjectCount: 24_700,
    includes: "originals_and_analysis",
  },
  r2: {
    cycleStart: "2026-08-01T00:00:00.000Z",
    classARequests: 42_000,
    classBRequests: 7_000,
    unknownRequests: 0,
    estimatedCostUsd: {
      storageRunRate: 0.045,
      classAThisCycle: 0,
      classBThisCycle: 0,
      currentMonthly: 0.045,
    },
  },
  mongo: {
    appData: {
      logicalDataBytes: 1_200_000_000,
      allocatedDocumentBytes: 520_000_000,
      allocatedIndexBytes: 80_000_000,
      allocatedTotalBytes: 600_000_000,
      measuredAt: "2026-08-11T16:29:00.000Z",
      scope: "sc2tools_database_only",
    },
    atlas: {
      available: true,
      cluster: {
        tier: "M10",
        provisionedDiskGb: 10,
        diskUsedBytes: 3_954_452_070,
        diskCapacityBytes: 10_632_560_640,
        diskMeasuredAt: "2026-08-11T16:25:00.000Z",
        autoExpandStorage: true,
      },
      billing: {
        available: true,
        cycleStart: "2026-08-01T00:00:00.000Z",
        cycleEnd: "2026-09-01T00:00:00.000Z",
        postedThrough: "2026-08-10T23:59:59.000Z",
        postedCycleCents: 2_000,
        categoryCents: {
          compute: 1_800,
          storage: 200,
          transfer: 0,
          other: 0,
        },
        projectedMonthlyRunRateUsd: 60,
      },
    },
    planning: { monthlyUsd: 56.94 },
  },
  site: {
    nonMongoFixedMonthlyUsd: 8.25,
    pricingMode: "atlas_projected",
    estimatedCurrentMonthlyTotalUsd: 68.295,
  },
} as const;

afterEach(() => {
  cleanup();
  getInfrastructureCostsMock.mockReset();
});

test("separates live usage, posted Atlas charges, and the projected run rate", async () => {
  getInfrastructureCostsMock.mockResolvedValue(COSTS);

  render(await DonatePage());

  expect(screen.getByText("Estimated monthly run rate")).toBeTruthy();
  expect(screen.getAllByText(/12\.3 GB stored/).length).toBeGreaterThan(0);
  expect(screen.getAllByText(/12,345 verified original replays/).length)
    .toBeGreaterThan(0);
  expect(screen.getByText(/\$8\.25 non-Mongo fixed \+ \$60\.00 projected Atlas \+ \$0\.05 R2 estimate/))
    .toBeTruthy();
  expect(screen.getAllByText(/\$68\.30/).length).toBeGreaterThan(0);
  expect(screen.getByText("Atlas charges posted this cycle")).toBeTruthy();
  expect(screen.getAllByText(/\$20\.00/).length).toBeGreaterThan(0);
  expect(screen.getAllByText(/3\.68 GiB of 9\.90 GiB/).length)
    .toBeGreaterThan(0);
  expect(screen.getByText(/572 MiB allocated/)).toBeTruthy();
  expect(screen.getByText(/compute \$18\.00, storage and backups \$2\.00/))
    .toBeTruthy();
  expect(screen.getAllByText(/not a full-month invoice/i).length)
    .toBeGreaterThan(0);
  expect(screen.getByText(/dashboard and invoice remain authoritative/i))
    .toBeTruthy();
});

test("adds live R2 to the planning baseline when Atlas billing is unavailable", async () => {
  getInfrastructureCostsMock.mockResolvedValue({
    ...COSTS,
    mongo: {
      ...COSTS.mongo,
      atlas: {
        available: false,
        cluster: null,
        billing: null,
      },
    },
    site: {
      ...COSTS.site,
      pricingMode: "planning_fallback",
      estimatedCurrentMonthlyTotalUsd: 65.235,
    },
  });

  render(await DonatePage());

  expect(screen.getByText(/planning fallback \+ live R2 estimate: \$65\.19 \+ \$0\.05 R2/))
    .toBeTruthy();
  expect(screen.getAllByText(/\$65\.24/).length).toBeGreaterThan(0);
  expect(screen.getByText(/instead of claiming a zero charge/i)).toBeTruthy();
});

test("shows an honest unavailable state instead of treating missing usage as zero", async () => {
  getInfrastructureCostsMock.mockResolvedValue(null);

  render(await DonatePage());

  expect(screen.getByText("Planning baseline")).toBeTruthy();
  expect(screen.getByText("No zero-cost assumption shown")).toBeTruthy();
  expect(screen.getByText(/no replay storage amount, R2 cost or live combined total has been invented/i))
    .toBeTruthy();
});
