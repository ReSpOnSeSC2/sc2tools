import path from "node:path";
import { defineConfig } from "@playwright/test";
import base from "../../playwright.config";

/** Owned local production-app proof. Refuse existing listeners so another
 * worktree's app cannot accidentally satisfy this branch's regression. */
export default defineConfig({
  ...base,
  testDir: path.resolve(__dirname, "../e2e"),
  outputDir: path.resolve(__dirname, "../../.cache/landing-playwright-results"),
  grep: /home-page replay demo|phone build editor/,
  retries: 0,
  workers: 1,
  webServer: (Array.isArray(base.webServer) ? base.webServer : [base.webServer!]).map(server => ({
    ...server,
    cwd: path.resolve(__dirname, "../.."),
    reuseExistingServer: false,
  })),
});
