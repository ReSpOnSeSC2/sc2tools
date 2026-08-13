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

describe("config loader - replay ingest admission", () => {
  test("defaults to one active memory-heavy replay batch", () => {
    expect(loadConfig({ ...BASE_ENV }).replayIngestMaxActive).toBe(1);
  });

  test("accepts an explicit measured-capacity override", () => {
    expect(loadConfig({
      ...BASE_ENV,
      REPLAY_INGEST_MAX_ACTIVE: "2",
    }).replayIngestMaxActive).toBe(2);
  });

  test("rejects a disabled admission limit", () => {
    expect(() => loadConfig({
      ...BASE_ENV,
      REPLAY_INGEST_MAX_ACTIVE: "0",
    })).toThrow(/REPLAY_INGEST_MAX_ACTIVE/);
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
      R2_BUCKET: "sample-replays-bucket",
      CLOUDFLARE_ACCOUNT_ID: "account-id",
      CLOUDFLARE_ANALYTICS_API_TOKEN: "analytics-token",
      CLOUDFLARE_BILLING_CYCLE_DAY: "15",
    });
    expect(cfg.cloudflareAnalytics).toEqual({
      accountId: "account-id",
      apiToken: "analytics-token",
      bucket: "sample-replays-bucket",
      billingCycleDay: 15,
    });
  });

  test.each([
    { CLOUDFLARE_ACCOUNT_ID: "account-id" },
    { CLOUDFLARE_ANALYTICS_API_TOKEN: "analytics-token" },
  ])("rejects partial analytics credentials: %p", (partial) => {
    expect(() => loadConfig({
      ...BASE_ENV,
      R2_BUCKET: "sample-replays-bucket",
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
      R2_BUCKET: "sample-replays-bucket",
      CLOUDFLARE_ACCOUNT_ID: "account-id",
      CLOUDFLARE_ANALYTICS_API_TOKEN: "analytics-token",
      CLOUDFLARE_BILLING_CYCLE_DAY: "29",
    })).toThrow(/1 to 28/);
  });
});

describe("config loader - Atlas infrastructure diagnostics", () => {
  const ATLAS = {
    ATLAS_SERVICE_ACCOUNT_ID: "service-account-id",
    ATLAS_SERVICE_ACCOUNT_SECRET: "service-account-secret",
    ATLAS_ORG_ID: "0123456789abcdef01234567",
    ATLAS_PROJECT_ID: "89abcdef0123456701234567",
    ATLAS_CLUSTER_NAME: "production-cluster",
  };

  test("is optional and accepts an all-or-none service-account block", () => {
    expect(loadConfig({ ...BASE_ENV }).atlasAdmin).toBeNull();
    expect(loadConfig({
      ...BASE_ENV,
      ...ATLAS,
      ATLAS_SERVICE_ACCOUNT_SECRET_EXPIRES_AT: "2028-01-01T00:00:00Z",
    }).atlasAdmin).toEqual({
      clientId: "service-account-id",
      clientSecret: "service-account-secret",
      orgId: "0123456789abcdef01234567",
      projectId: "89abcdef0123456701234567",
      clusterName: "production-cluster",
      secretExpiresAt: "2028-01-01T00:00:00.000Z",
    });
  });

  test("rejects partial credentials and malformed expiry metadata", () => {
    expect(() => loadConfig({
      ...BASE_ENV,
      ATLAS_SERVICE_ACCOUNT_ID: "service-account-id",
    })).toThrow(/must be set together/);
    expect(() => loadConfig({
      ...BASE_ENV,
      ...ATLAS,
      ATLAS_SERVICE_ACCOUNT_SECRET_EXPIRES_AT: "next summer",
    })).toThrow(/ISO 8601/);
    expect(() => loadConfig({
      ...BASE_ENV,
      ATLAS_SERVICE_ACCOUNT_SECRET_EXPIRES_AT: "2028-01-01T00:00:00Z",
    })).toThrow(/must be set together/);
  });
});

describe("config loader - Render capacity diagnostics", () => {
  test("is optional and accepts the API key with Render's service id", () => {
    expect(loadConfig({ ...BASE_ENV }).renderAdmin).toBeNull();
    expect(loadConfig({
      ...BASE_ENV,
      RENDER_SERVICE_ID: "srv-automatically-injected",
    }).renderAdmin).toBeNull();
    expect(loadConfig({
      ...BASE_ENV,
      RENDER_API_KEY: "rnd_secret",
      RENDER_SERVICE_ID: "srv-example",
      RENDER_MONTHLY_COST_USD: "7.00",
    }).renderAdmin).toEqual({
      apiKey: "rnd_secret",
      serviceId: "srv-example",
      monthlyCostUsd: 7,
    });
  });

  test("rejects partial credentials and malformed planning cost", () => {
    expect(() => loadConfig({
      ...BASE_ENV,
      RENDER_API_KEY: "rnd_secret",
    })).toThrow(/must be set together/);
    expect(() => loadConfig({
      ...BASE_ENV,
      RENDER_API_KEY: "rnd_secret",
      RENDER_SERVICE_ID: "srv-example",
      RENDER_MONTHLY_COST_USD: "seven",
    })).toThrow(/non-negative USD/);
  });
});
