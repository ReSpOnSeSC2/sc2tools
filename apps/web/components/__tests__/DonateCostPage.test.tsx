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
  site: {
    fixedMonthlyEquivalentUsd: 65.19,
    estimatedCurrentMonthlyTotalUsd: 65.235,
  },
} as const;

afterEach(() => {
  cleanup();
  getInfrastructureCostsMock.mockReset();
});

test("renders provider usage, the R2 estimate, and the combined total", async () => {
  getInfrastructureCostsMock.mockResolvedValue(COSTS);

  render(await DonatePage());

  expect(screen.getByText("Estimated current monthly total")).toBeTruthy();
  expect(screen.getAllByText(/12\.3 GB stored/).length).toBeGreaterThan(0);
  expect(screen.getAllByText(/12,345 verified original replays/).length)
    .toBeGreaterThan(0);
  expect(screen.getByText(/\$65\.19 fixed \+ \$0\.05 R2 estimate/)).toBeTruthy();
  expect(screen.getAllByText(/\$65\.24/).length).toBeGreaterThan(0);
  expect(screen.getByText(/dashboard and invoice remain authoritative/i))
    .toBeTruthy();
});

test("shows an honest unavailable state instead of treating missing usage as zero", async () => {
  getInfrastructureCostsMock.mockResolvedValue(null);

  render(await DonatePage());

  expect(screen.getByText("Live archive usage temporarily unavailable"))
    .toBeTruthy();
  expect(screen.getByText("No zero-cost assumption shown")).toBeTruthy();
  expect(screen.getByText(/no replay storage amount, R2 cost or combined total has been invented/i))
    .toBeTruthy();
});
