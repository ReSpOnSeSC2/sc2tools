import path from "node:path";
import { defineConfig } from "@playwright/test";

if (!process.env.SESSIONS_HISTORY_BROWSER_FINGERPRINT) throw new Error("Supply the new root-reviewed history source/import/build/bundle fingerprint");
if (!process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE) throw new Error("Supply the root-pinned installed Chromium executable; no browser download");
if (process.env.A11Y_COLLECT_ONLY) throw new Error("History verification preserves every AA impact gate");

export default defineConfig({
  testDir: path.resolve(__dirname, "."), testMatch: "sessions-history-browser.spec.ts",
  outputDir: process.env.SESSIONS_HISTORY_BROWSER_OUTPUT ?? path.resolve(__dirname, "../../.cache/sessions-history-browser-results"),
  fullyParallel: false, workers: 1, retries: 0, maxFailures: 1, forbidOnly: true,
  timeout: 60_000, globalTimeout: 15 * 60_000, expect: { timeout: 8000 },
  use: { browserName: "chromium", serviceWorkers: "block", actionTimeout: 8000, navigationTimeout: 15_000,
    timezoneId: "America/New_York", launchOptions: { executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE },
    trace: "retain-on-failure", screenshot: "only-on-failure" },
  projects: [
    { name: "sessions-history-phone-390", grepInvert: /@native200/, use: { viewport: { width: 390, height: 844 } } },
    { name: "sessions-history-desktop-1280", grepInvert: /@native200/, use: { viewport: { width: 1280, height: 900 } } },
    { name: "sessions-history-native-200", grep: /@native200/ },
  ],
});
