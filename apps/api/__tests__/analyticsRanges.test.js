"use strict";
const { AnalyticsService, _internals } = require("../src/services/analytics");

describe("GA4 custom date windows", () => {
  test("passes current and previous custom windows to the provider", async () => {
    const runReport = jest.fn(async (_request = /** @type {Record<string, any>} */ ({})) => [{ rows: [] }]);
    const service = new AnalyticsService({ config: { enabled: true, propertyId: "123", credentials: null, keyFile: null }, clientFactory: () => ({ runReport }) });
    const out = await service.summary({ from: "2026-01-10", to: "2026-01-12" });
    expect(out.range).toEqual({ days: 3, startDate: "2026-01-10", endDate: "2026-01-12" });
    expect(runReport.mock.calls.map(([request]) => {
      if (!request) throw new Error("Provider request missing");
      return request.dateRanges[0];
    })).toEqual([
      { startDate: "2026-01-10", endDate: "2026-01-12" },
      { startDate: "2026-01-07", endDate: "2026-01-09" },
      ...Array.from({ length: 4 }, () => ({ startDate: "2026-01-10", endDate: "2026-01-12" })),
    ]);
  });
  test("uses inclusive dates and the equal-length previous window", () => {
    expect(_internals.analyticsRange({ from: "2026-01-10", to: "2026-01-12" })).toEqual({
      days: 3,
      cur: { startDate: "2026-01-10", endDate: "2026-01-12" },
      prev: { startDate: "2026-01-07", endDate: "2026-01-09" },
    });
  });
  test.each([
    { from: "2026-02-30", to: "2026-03-01" },
    { from: "2026-01-12", to: "2026-01-10" },
    { from: "2024-01-01", to: "2026-01-01" },
    { from: "2026-01-01", to: "2999-01-01" },
    { from: "2026-01-01" },
    { from: ["2026-01-01"], to: "2026-01-02" },
  ])("rejects invalid range %j", (range) => {
    expect(() => _internals.analyticsRange(range)).toThrow(expect.objectContaining({ status: 400, code: "bad_request" }));
  });
  test("keeps the existing days path", () => {
    expect(_internals.analyticsRange({ days: 7 })).toMatchObject({ days: 7, cur: { startDate: "6daysAgo", endDate: "today" }, prev: { startDate: "13daysAgo", endDate: "7daysAgo" } });
  });
});
