import { beforeEach, describe, expect, test, vi } from "vitest";

const getJsonMock = vi.hoisted(() => vi.fn());

vi.mock("@/lib/serverApi", () => ({
  getJson: (...args: unknown[]) => getJsonMock(...args),
}));

import {
  formatAtlasDiskBytes,
  formatBinaryStorageBytes,
  formatReplayCount,
  formatStorageBytes,
  formatUsd,
  getInfrastructureCosts,
  monthlyCostSummary,
  normalizeInfrastructureCosts,
} from "./infrastructureCosts";

const VALID_PAYLOAD = {
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

beforeEach(() => {
  getJsonMock.mockReset();
});

describe("infrastructure cost response validation", () => {
  test("accepts a complete aggregate snapshot", () => {
    const value = normalizeInfrastructureCosts(VALID_PAYLOAD);
    expect(value?.archive.verifiedOriginalReplays).toBe(12_345);
    expect(value?.r2.estimatedCostUsd.currentMonthly).toBe(0.045);
    expect(value?.mongo.atlas.cluster?.diskUsedBytes).toBe(3_954_452_070);
    expect(value?.mongo.atlas.billing?.postedCycleCents).toBe(2_000);
  });

  test.each([
    null,
    {},
    { ...VALID_PAYLOAD, asOf: "not-a-date" },
    {
      ...VALID_PAYLOAD,
      archive: { ...VALID_PAYLOAD.archive, r2StoredBytes: -1 },
    },
    {
      ...VALID_PAYLOAD,
      r2: { ...VALID_PAYLOAD.r2, unknownRequests: 0.5 },
    },
    {
      ...VALID_PAYLOAD,
      site: {
        ...VALID_PAYLOAD.site,
        estimatedCurrentMonthlyTotalUsd: Number.NaN,
      },
    },
    {
      ...VALID_PAYLOAD,
      mongo: {
        ...VALID_PAYLOAD.mongo,
        appData: {
          ...VALID_PAYLOAD.mongo.appData,
          allocatedTotalBytes: 599_999_999,
        },
      },
    },
    {
      ...VALID_PAYLOAD,
      mongo: {
        ...VALID_PAYLOAD.mongo,
        atlas: {
          ...VALID_PAYLOAD.mongo.atlas,
          billing: {
            ...VALID_PAYLOAD.mongo.atlas.billing,
            postedCycleCents: -1,
          },
        },
      },
    },
  ])("rejects partial or unsafe public cost data", (value) => {
    expect(normalizeInfrastructureCosts(value)).toBeNull();
  });

  test("fetches through the shared 15-minute Next cache policy", async () => {
    getJsonMock.mockResolvedValue(VALID_PAYLOAD);
    await expect(getInfrastructureCosts()).resolves.toEqual(VALID_PAYLOAD);
    expect(getJsonMock).toHaveBeenCalledWith(
      "/v1/public/infrastructure-costs",
      { revalidateSec: 900 },
    );
  });

  test("turns an unavailable or malformed upstream value into null", async () => {
    getJsonMock.mockResolvedValue({ archive: {} });
    await expect(getInfrastructureCosts()).resolves.toBeNull();
  });
});

describe("monthly cost accounting", () => {
  test("uses the projected Atlas run rate with the non-Mongo fixed costs", () => {
    const costs = normalizeInfrastructureCosts(VALID_PAYLOAD);
    expect(costs).not.toBeNull();
    expect(monthlyCostSummary(costs!)).toEqual({
      mode: "atlas_projected",
      baseUsd: 8.25,
      atlasUsd: 60,
      r2Usd: 0.045,
      totalUsd: 68.295,
    });
  });

  test("uses the planning baseline plus live R2 when Atlas billing is unavailable", () => {
    const payload = {
      ...VALID_PAYLOAD,
      mongo: {
        ...VALID_PAYLOAD.mongo,
        atlas: {
          available: false,
          cluster: null,
          billing: null,
        },
      },
      site: {
        ...VALID_PAYLOAD.site,
        pricingMode: "planning_fallback",
        estimatedCurrentMonthlyTotalUsd: 65.235,
      },
    } as const;
    const costs = normalizeInfrastructureCosts(payload);
    expect(costs).not.toBeNull();
    expect(monthlyCostSummary(costs!)).toEqual({
      mode: "planning_fallback",
      baseUsd: 65.19,
      atlasUsd: 56.94,
      r2Usd: 0.045,
      totalUsd: 65.235,
    });
  });
});

describe("public cost formatting", () => {
  test.each([
    [0, "0 B"],
    [999, "999 B"],
    [1_500, "1.5 KB"],
    [2_345_000, "2.35 MB"],
    [12_340_000_000, "12.3 GB"],
    [1_234_000_000_000, "1.23 TB"],
  ])("formats %d bytes in decimal provider units", (bytes, expected) => {
    expect(formatStorageBytes(bytes)).toBe(expected);
  });

  test("does not turn an invalid byte value into a zero claim", () => {
    expect(formatStorageBytes(Number.NaN)).toBe("Unavailable");
    expect(formatStorageBytes(-1)).toBe("Unavailable");
  });

  test("formats Atlas and Mongo byte metrics in honest binary units", () => {
    expect(formatAtlasDiskBytes(3_954_452_070)).toBe("3.68 GiB");
    expect(formatAtlasDiskBytes(10_632_560_640)).toBe("9.90 GiB");
    expect(formatBinaryStorageBytes(600_000_000)).toBe("572 MiB");
  });

  test("shows exact replay counts and currency to cents", () => {
    expect(formatReplayCount(12_345)).toBe("12,345");
    expect(formatUsd(0)).toBe("$0.00");
    expect(formatUsd(65.235)).toBe("$65.24");
  });
});
