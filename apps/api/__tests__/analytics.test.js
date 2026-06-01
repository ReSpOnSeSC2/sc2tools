// @ts-nocheck
"use strict";

/**
 * AnalyticsService + analytics config parsing.
 *
 * The service is a pure adapter over the GA4 Data API, so we inject a
 * fake client (``clientFactory``) that returns canned ``runReport`` /
 * ``runRealtimeReport`` payloads shaped exactly like the real API
 * (``rows[].dimensionValues[].value`` / ``metricValues[].value``). That
 * lets us pin the row-shaping, totals roll-up, and delta math without
 * any network or credentials.
 */

const { AnalyticsService } = require("../src/services/analytics");
const { parseAnalyticsConfig } = require("../src/config/loader");

/** Build a GA-style report response from compact [dims, metrics] rows. */
function report(rows) {
  return [
    {
      rows: rows.map(([dims, metrics]) => ({
        dimensionValues: dims.map((value) => ({ value: String(value) })),
        metricValues: metrics.map((value) => ({ value: String(value) })),
      })),
    },
  ];
}

/**
 * Fake Data API client. ``runReport`` dispatches on which dimension
 * was requested so each of the service's parallel reports gets a
 * distinct, realistic payload.
 */
function fakeClient() {
  return {
    runReport: jest.fn(async (req) => {
      const dimName = (req.dimensions && req.dimensions[0] && req.dimensions[0].name) || null;
      if (dimName === "date") {
        // Two-day timeseries. Metric order matches CORE_METRICS:
        // activeUsers, newUsers, sessions, screenPageViews,
        // engagementRate, averageSessionDuration.
        return report([
          [["20260530"], [10, 4, 12, 30, 0.5, 60]],
          [["20260531"], [20, 6, 18, 50, 0.7, 80]],
        ]);
      }
      if (dimName === "pagePath") {
        return report([
          [["/", "Home"], [80, 25]],
          [["/app", "Analyzer"], [40, 15]],
        ]);
      }
      if (dimName === "sessionDefaultChannelGroup") {
        return report([[["Organic Search"], [20, 12]], [["Direct"], [10, 8]]]);
      }
      if (dimName === "deviceCategory") {
        return report([[["desktop"], [25, 22]], [["mobile"], [5, 8]]]);
      }
      if (dimName === "country") {
        return report([[["United States"], [18]], [["Germany"], [9]]]);
      }
      // No dimensions → the prior-period totals report.
      return report([[[], [12, 3, 14, 28, 0.4, 55]]]);
    }),
    runRealtimeReport: jest.fn(async () =>
      report([[["United States"], [3]], [["Canada"], [2]]]),
    ),
  };
}

const ENABLED_CONFIG = {
  enabled: true,
  propertyId: "123456789",
  credentials: { client_email: "x@y.iam.gserviceaccount.com", private_key: "k" },
  keyFile: null,
};

describe("AnalyticsService.summary", () => {
  let svc;
  beforeEach(() => {
    svc = new AnalyticsService({
      config: ENABLED_CONFIG,
      clientFactory: fakeClient,
    });
  });

  it("rolls the daily series up into headline totals", async () => {
    const out = await svc.summary({ days: 28 });
    expect(out.configured).toBe(true);
    expect(out.range.days).toBe(28);
    // 10+20 active users, 4+6 new, 12+18 sessions, 30+50 views.
    expect(out.totals.activeUsers).toBe(30);
    expect(out.totals.newUsers).toBe(10);
    expect(out.totals.sessions).toBe(30);
    expect(out.totals.screenPageViews).toBe(80);
    // Rates are averaged across the two days.
    expect(out.totals.engagementRate).toBeCloseTo(0.6, 5);
    expect(out.totals.averageSessionDuration).toBeCloseTo(70, 5);
  });

  it("computes prior-period deltas as percentages", async () => {
    const out = await svc.summary({ days: 28 });
    // activeUsers 30 vs prior 12 → +150%.
    expect(out.deltas.activeUsers).toBeCloseTo(150, 1);
    expect(out.previous.activeUsers).toBe(12);
  });

  it("shapes the breakdown tables", async () => {
    const out = await svc.summary({ days: 7 });
    expect(out.topPages[0]).toEqual({
      path: "/",
      title: "Home",
      views: 80,
      activeUsers: 25,
    });
    expect(out.channels[0]).toEqual({
      channel: "Organic Search",
      sessions: 20,
      activeUsers: 12,
    });
    expect(out.devices[0].device).toBe("desktop");
    expect(out.countries[0]).toEqual({
      country: "United States",
      activeUsers: 18,
    });
    expect(out.timeseries).toHaveLength(2);
    expect(out.timeseries[0].date).toBe("2026-05-30");
  });

  it("clamps the day window into [1, 365]", async () => {
    const tiny = await svc.summary({ days: 0 });
    expect(tiny.range.days).toBe(1);
    const huge = await svc.summary({ days: 9999 });
    expect(huge.range.days).toBe(365);
  });
});

describe("AnalyticsService.realtime", () => {
  it("sums active users across the per-country rows", async () => {
    const svc = new AnalyticsService({
      config: ENABLED_CONFIG,
      clientFactory: fakeClient,
    });
    const out = await svc.realtime();
    expect(out.configured).toBe(true);
    expect(out.activeUsers).toBe(5);
    expect(out.byCountry).toHaveLength(2);
  });
});

describe("AnalyticsService.isEnabled", () => {
  it("reflects the config flag", () => {
    expect(new AnalyticsService({ config: ENABLED_CONFIG }).isEnabled()).toBe(true);
    expect(
      new AnalyticsService({
        config: { enabled: false, propertyId: null, credentials: null, keyFile: null },
      }).isEnabled(),
    ).toBe(false);
  });
});

describe("parseAnalyticsConfig", () => {
  it("is disabled with no property id", () => {
    expect(parseAnalyticsConfig({}).enabled).toBe(false);
  });

  it("is disabled with a property id but no credential source", () => {
    expect(parseAnalyticsConfig({ GA4_PROPERTY_ID: "123" }).enabled).toBe(false);
  });

  it("enables via a base64 service-account key", () => {
    const key = { client_email: "a@b.iam.gserviceaccount.com", private_key: "pk" };
    const b64 = Buffer.from(JSON.stringify(key)).toString("base64");
    const cfg = parseAnalyticsConfig({
      GA4_PROPERTY_ID: "123",
      GA_SERVICE_ACCOUNT_KEY_B64: b64,
    });
    expect(cfg.enabled).toBe(true);
    expect(cfg.credentials.client_email).toBe(key.client_email);
  });

  it("enables via a key file path (ADC)", () => {
    const cfg = parseAnalyticsConfig({
      GA4_PROPERTY_ID: "123",
      GOOGLE_APPLICATION_CREDENTIALS: "/secrets/ga.json",
    });
    expect(cfg.enabled).toBe(true);
    expect(cfg.credentials).toBeNull();
    expect(cfg.keyFile).toBe("/secrets/ga.json");
  });

  it("throws on malformed base64 JSON", () => {
    expect(() =>
      parseAnalyticsConfig({
        GA4_PROPERTY_ID: "123",
        GA_SERVICE_ACCOUNT_KEY_B64: Buffer.from("not json").toString("base64"),
      }),
    ).toThrow(/valid JSON/);
  });

  it("throws when the decoded key lacks client_email / private_key", () => {
    const b64 = Buffer.from(JSON.stringify({ foo: "bar" })).toString("base64");
    expect(() =>
      parseAnalyticsConfig({ GA4_PROPERTY_ID: "123", GA_SERVICE_ACCOUNT_KEY_B64: b64 }),
    ).toThrow(/client_email/);
  });
});
