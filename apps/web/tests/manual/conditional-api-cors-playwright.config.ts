import path from "node:path";
import fs from "node:fs";
import { defineConfig } from "@playwright/test";

// Deliberately independent of the public smoke config: no Next, default API,
// existing-listener reuse, engine/sample generator, install or Mongo process.
const root = process.cwd();
if (JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8")).name !== "@sc2tools/web") {
  throw new Error("Run from apps/web. Paths use verified cwd and work under the CJS Playwright loader.");
}
const executablePath = process.env.PW_CHROMIUM_EXECUTABLE;
if (!executablePath || !path.isAbsolute(executablePath) || !fs.statSync(executablePath).isFile()) {
  throw new Error("PW_CHROMIUM_EXECUTABLE must name the existing root-reviewed Chrome1228 binary; no browser download.");
}
export default defineConfig({
  testDir: path.join(root, "tests/manual"), testMatch: "conditional-api-cors.spec.ts",
  outputDir: path.resolve(process.env.ETAG_BROWSER_RESULTS_DIR || path.join(root, ".cache/conditional-api-cors-results")),
  timeout: 30_000, globalTimeout: 120_000, workers: 1, fullyParallel: false, retries: 0, maxFailures: 1,
  reporter: [["list"], ["json", { outputFile: path.resolve(process.env.ETAG_BROWSER_REPORT || path.join(root, ".cache/conditional-api-cors-report.json")) }]],
  use: {
    browserName: "chromium", headless: true, serviceWorkers: "block", trace: "retain-on-failure",
    launchOptions: { executablePath, args: ["--proxy-server=direct://", "--proxy-bypass-list=*"] },
  },
  projects: [
    { name: "mobile-360", use: { viewport: { width: 360, height: 800 } } },
    { name: "desktop-1280", use: { viewport: { width: 1280, height: 800 } } },
  ],
});
