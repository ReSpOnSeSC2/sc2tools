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
