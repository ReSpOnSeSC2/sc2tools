import { beforeEach, describe, expect, test, vi } from "vitest";

const getJsonMock = vi.hoisted(() => vi.fn());

vi.mock("@/lib/serverApi", () => ({
  getJson: (...args: unknown[]) => getJsonMock(...args),
}));

import {
  formatReplayCount,
  formatStorageBytes,
  formatUsd,
  getInfrastructureCosts,
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
  site: {
    fixedMonthlyEquivalentUsd: 65.19,
    estimatedCurrentMonthlyTotalUsd: 65.235,
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

  test("shows exact replay counts and currency to cents", () => {
    expect(formatReplayCount(12_345)).toBe("12,345");
    expect(formatUsd(0)).toBe("$0.00");
    expect(formatUsd(65.235)).toBe("$65.24");
  });
});
