"use strict";

const { loadConfig } = require("../src/config/loader");

const BASE_ENV = {
  MONGODB_URI: "mongodb://localhost:27017",
  CLERK_SECRET_KEY: "sk_test_x",
  SERVER_PEPPER_HEX: "a".repeat(64),
};

describe("config loader — CORS allowlist fail-fast", () => {
  test("production boot refuses an empty CORS allowlist", () => {
    expect(() =>
      loadConfig({ ...BASE_ENV, NODE_ENV: "production" }),
    ).toThrow(/CORS_ALLOWED_ORIGINS/);
  });

  test("production boots with an allowlist set", () => {
    const cfg = loadConfig({
      ...BASE_ENV,
      NODE_ENV: "production",
      CORS_ALLOWED_ORIGINS: "https://sc2tools.com,https://www.sc2tools.com",
    });
    expect(cfg.corsAllowedOrigins).toEqual([
      "https://sc2tools.com",
      "https://www.sc2tools.com",
    ]);
  });

  test("dev/test boot stays permissive without the env var", () => {
    const cfg = loadConfig({ ...BASE_ENV });
    expect(cfg.corsAllowedOrigins).toEqual([]);
  });
});

describe("config loader - original replay storage", () => {
  test("is explicitly disabled by default", () => {
    expect(loadConfig({ ...BASE_ENV }).replayFilesStore).toBe("disabled");
  });

  test("accepts the R2 backend", () => {
    expect(loadConfig({
      ...BASE_ENV,
      REPLAY_FILES_STORE: "r2",
    }).replayFilesStore).toBe("r2");
  });

  test("rejects an unknown backend", () => {
    expect(() => loadConfig({
      ...BASE_ENV,
      REPLAY_FILES_STORE: "filesystem",
    })).toThrow(/REPLAY_FILES_STORE/);
  });
});

describe("config loader - Cloudflare infrastructure analytics", () => {
  test("is optional when both credentials are absent", () => {
    expect(loadConfig({ ...BASE_ENV }).cloudflareAnalytics).toBeNull();
  });

  test("accepts the all-or-none analytics block and custom cycle day", () => {
    const cfg = loadConfig({
      ...BASE_ENV,
      R2_BUCKET: "sc2tools-replays-prod",
      CLOUDFLARE_ACCOUNT_ID: "account-id",
      CLOUDFLARE_ANALYTICS_API_TOKEN: "analytics-token",
      CLOUDFLARE_BILLING_CYCLE_DAY: "15",
    });
    expect(cfg.cloudflareAnalytics).toEqual({
      accountId: "account-id",
      apiToken: "analytics-token",
      bucket: "sc2tools-replays-prod",
      billingCycleDay: 15,
    });
  });

  test.each([
    { CLOUDFLARE_ACCOUNT_ID: "account-id" },
    { CLOUDFLARE_ANALYTICS_API_TOKEN: "analytics-token" },
  ])("rejects partial analytics credentials: %p", (partial) => {
    expect(() => loadConfig({
      ...BASE_ENV,
      R2_BUCKET: "sc2tools-replays-prod",
      ...partial,
    })).toThrow(/must be set together/);
  });

  test("requires the existing R2 bucket and a cycle day from 1 to 28", () => {
    expect(() => loadConfig({
      ...BASE_ENV,
      CLOUDFLARE_ACCOUNT_ID: "account-id",
      CLOUDFLARE_ANALYTICS_API_TOKEN: "analytics-token",
    })).toThrow(/R2_BUCKET/);
    expect(() => loadConfig({
      ...BASE_ENV,
      R2_BUCKET: "sc2tools-replays-prod",
      CLOUDFLARE_ACCOUNT_ID: "account-id",
      CLOUDFLARE_ANALYTICS_API_TOKEN: "analytics-token",
      CLOUDFLARE_BILLING_CYCLE_DAY: "29",
    })).toThrow(/1 to 28/);
  });
});
