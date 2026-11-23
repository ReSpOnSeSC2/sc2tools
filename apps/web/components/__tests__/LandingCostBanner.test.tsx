import { afterEach, expect, test } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { DonateBanner } from "@/components/landing/DonateBanner";
import type { InfrastructureCosts } from "@/lib/infrastructureCosts";

afterEach(cleanup);

const COSTS: InfrastructureCosts = {
  asOf: "2026-08-11T16:30:00.000Z",
  stale: true,
  estimate: true,
  archive: {
    verifiedOriginalReplays: 4_711,
    r2StoredBytes: 444_228_494,
    r2ObjectCount: 8_419,
    includes: "originals_and_analysis",
  },
  r2: {
    cycleStart: "2026-08-11T00:00:00.000Z",
    classARequests: 14_530,
    classBRequests: 15_146,
    unknownRequests: 0,
    estimatedCostUsd: {
      storageRunRate: 0,
      classAThisCycle: 0,
      classBThisCycle: 0,
      currentMonthly: 0,
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
        postedThrough: "2026-08-11T00:00:00.000Z",
        postedCycleCents: 2_859,
        categoryCents: {
          compute: 1_970,
          storage: 268,
          transfer: 621,
          other: 0,
        },
        projectedMonthlyRunRateUsd: 88.63,
      },
    },
    planning: { monthlyUsd: 8 },
  },
  site: {
    nonMongoFixedMonthlyUsd: 8.25,
    pricingMode: "atlas_projected",
    estimatedCurrentMonthlyTotalUsd: 96.88,
  },
};

test("labels a stale landing cost snapshot instead of calling it current", () => {
  render(<DonateBanner costs={COSTS} />);

  expect(screen.getByRole("heading").textContent).toContain(
    "latest available provider snapshot",
  );
  expect(screen.getByText(/Last successful provider snapshot/)).toBeTruthy();
  expect(screen.getByText(/live refresh is currently delayed/)).toBeTruthy();
});

test("describes Atlas Flex storage and its live run rate on the landing banner", () => {
  render(
    <DonateBanner
      costs={{
        ...COSTS,
        stale: false,
        mongo: {
          ...COSTS.mongo,
          atlas: {
            available: true,
            cluster: {
              tier: "FLEX",
              provisionedDiskGb: 5,
              diskUsedBytes: null,
              diskCapacityBytes: null,
              diskMeasuredAt: null,
              autoExpandStorage: false,
            },
            billing: {
              ...COSTS.mongo.atlas.billing!,
              postedCycleCents: 60,
              categoryCents: { compute: 60, storage: 0, transfer: 0, other: 0 },
              projectedMonthlyRunRateUsd: 9.3,
            },
          },
        },
        site: { ...COSTS.site, estimatedCurrentMonthlyTotalUsd: 17.55 },
      }}
    />,
  );

  expect(screen.getByRole("heading").textContent).toContain("about $17.55 a month");
  expect(screen.getByText(/on Atlas Flex, which includes up to 5 GB of data and indexes/))
    .toBeTruthy();
  expect(screen.getByText(/\$9\.30 projected Atlas run rate/)).toBeTruthy();
  expect(screen.queryByText(/disk telemetry is unavailable/)).toBeNull();
});
