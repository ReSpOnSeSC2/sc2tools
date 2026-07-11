import { defineConfig } from "@playwright/test";

/**
 * Engine override for machines whose Chromium is policy-locked (some
 * Windows AV/proxy setups block headless Chromium's loopback access
 * with ERR_NAME_NOT_RESOLVED even for IP literals):
 *   PW_BROWSER=firefox npx playwright test
 * CI keeps the Chromium default.
 */
const BROWSER = process.env.PW_BROWSER === "firefox" ? "firefox" : "chromium";

/**
 * Responsive smoke net for the PUBLIC pages — the regression guard the
 * design-QA workstream mandates: every public surface must render at
 * phone / tablet / desktop widths with no body-level horizontal
 * scroll.
 *
 * Scope is deliberately public-only: auth-gated surfaces need real
 * Clerk test credentials, which CI doesn't hold. The app is built +
 * started with a format-valid dummy Clerk key (the standard CI trick —
 * the key is only validated on actual Clerk API calls, which public
 * pages never make) and no API backend: pages must degrade to their
 * empty/unavailable states, never crash — which is itself part of what
 * this suite asserts.
 *
 * Run locally:
 *   npm run build   (with the dummy env below)
 *   npx playwright test
 */
export default defineConfig({
  testDir: "./tests/e2e",
  timeout: 30_000,
  fullyParallel: true,
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? "github" : "list",
  use: {
    // 127.0.0.1, not localhost: Chromium's resolver can fail on
    // localhost under some Windows IPv6/hosts configurations even when
    // Node resolves it fine.
    baseURL: "http://127.0.0.1:3210",
    // A system proxy (VPN/corporate) makes Chromium "resolve" even IP
    // literals through the proxy — ERR_NAME_NOT_RESOLVED on loopback.
    // The args pair forces direct connections and outranks policy
    // proxies where --no-proxy-server alone does not. Local-only
    // because CI runners have no system proxy to defeat.
    // Chromium-only flags — Firefox rejects them at spawn.
    launchOptions:
      BROWSER === "chromium" && !process.env.CI
        ? { args: ["--proxy-server=direct://", "--proxy-bypass-list=*"] }
        : {},
  },
  projects: [
    {
      name: "mobile-360",
      use: { browserName: BROWSER, viewport: { width: 360, height: 800 } },
    },
    {
      name: "tablet-768",
      use: { browserName: BROWSER, viewport: { width: 768, height: 1024 } },
    },
    {
      name: "desktop-1280",
      use: { browserName: BROWSER, viewport: { width: 1280, height: 800 } },
    },
  ],
  webServer: {
    // Default (dual-stack) bind on purpose: Next self-proxies internal
    // requests to localhost:<port>, which resolves to ::1 on Windows —
    // a 127.0.0.1-only bind 500s every page. The BROWSER still targets
    // 127.0.0.1 (baseURL) because Chromium's resolver can fail on
    // `localhost` under some Windows configurations.
    command: "npx next start -p 3210",
    url: "http://127.0.0.1:3210",
    reuseExistingServer: !process.env.CI,
    timeout: 60_000,
    env: {
      // Format-valid dummies — decode to clerk.example.com$. Public
      // pages never call Clerk's API, so they're never exercised.
      // PRODUCTION-format (pk_live) on purpose: a pk_test key makes
      // clerkMiddleware run the dev-instance "dev browser" handshake,
      // redirecting every real-browser document request to the key's
      // frontend-API domain (the nonexistent clerk.example.com) —
      // browsers then die with ERR_NAME_NOT_RESOLVED while curl and
      // Node fetch (not browsers) get a 200. On a dev machine whose
      // apps/web/.env.local holds REAL pk_test keys the handshake
      // bounces through the real Clerk domain and back, which is why
      // this only ever failed in CI. Production instances skip the
      // handshake entirely.
      NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY: "pk_live_Y2xlcmsuZXhhbXBsZS5jb20k",
      CLERK_SECRET_KEY: "sk_live_dummy",
      NEXT_PUBLIC_API_BASE: "http://localhost:8080",
    },
  },
});
