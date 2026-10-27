import path from "node:path";
import { defineConfig } from "@playwright/test";

if (!process.env.SESSIONS_BROWSER_FINGERPRINT) throw new Error("Supply the root-reviewed final Sessions source/build/fixture fingerprint");
if (!process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE) throw new Error("Supply the root-pinned installed Chromium executable; no browser download");
if (process.env.A11Y_COLLECT_ONLY) throw new Error("Sessions verification preserves full AA gates");

export default defineConfig({
  testDir: path.resolve(__dirname, "."), testMatch: "sessions-browser.spec.ts",
  outputDir: process.env.SESSIONS_BROWSER_OUTPUT ?? path.resolve(__dirname, "../../.cache/sessions-browser-results"),
  fullyParallel: false, workers: 1, retries: 0, maxFailures: 1, forbidOnly: true,
  timeout: 60_000, globalTimeout: 12 * 60_000,
  expect: { timeout: 8000 },
  use: { browserName: "chromium", serviceWorkers: "block", actionTimeout: 8000, navigationTimeout: 15_000,
    launchOptions: { executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE },
    trace: "retain-on-failure", screenshot: "only-on-failure" },
  projects: [
    { name: "sessions-phone-390", use: { viewport: { width: 390, height: 844 } } },
    { name: "sessions-desktop-1280", use: { viewport: { width: 1280, height: 900 } } },
  ],
});
