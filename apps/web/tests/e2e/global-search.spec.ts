import { expect, test, type Page, type Request, type Route } from "@playwright/test";

// Runs against the existing actual Next webServer + mock-review-api fixture.
// No component/auth/router/search hook is replaced by this spec.
const METADATA_PATHS = new Set(["/v1/guides", "/v1/guides/sitemap"]);
const API_HOSTS = new Set(["localhost:8080", "127.0.0.1:8080"]);
const SENTINEL = "private-query-sentinel-b1";
function isMetadataUrl(url: URL): boolean {
  return url.protocol === "http:" && API_HOSTS.has(url.host) && METADATA_PATHS.has(url.pathname);
}
function metadataRequest(request: Request): boolean {
  return request.method() === "GET" && isMetadataUrl(new URL(request.url()));
}
function palette(page: Page) {
  return page.getByRole("dialog").filter({ has: page.getByRole("combobox", { name: /^(Search|Find a guide)$/ }) });
}
function query(page: Page) { return palette(page).getByRole("combobox"); }
function form(page: Page) { return page.getByRole("search", { name: "Find a guide", exact: true }); }
async function openPage(page: Page, href: string) {
  const response = await page.goto(href);
  expect(response?.status()).toBe(200);
  const reject = page.getByRole("button", { name: "Reject", exact: true });
  if (await reject.isVisible()) await reject.click();
  await expect(form(page)).toBeVisible();
}
async function submitGuide(page: Page, text: string) {
  await form(page).getByRole("searchbox").fill(text);
  await form(page).getByRole("button", { name: "Search", exact: true }).click();
  await expect(palette(page)).toBeVisible();
  await expect(query(page)).toBeFocused();
}
async function ready(page: Page) {
  await expect(palette(page).getByRole("status")).not.toContainText("Loading guide availability");
  await expect(palette(page).getByRole("button", { name: "Retry guide availability", exact: true })).toHaveCount(0);
}
async function twoFrames(page: Page) {
  await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
}
function recordMetadata(page: Page): Request[] {
  const requests: Request[] = [];
  page.on("request", request => { if (metadataRequest(request)) requests.push(request); });
  return requests;
}
function anonymousMetadata(requests: readonly Request[]) {
  for (const request of requests) {
    expect(new URL(request.url()).search).toBe("");
    expect(request.headers().authorization).toBeUndefined();
    expect(request.headers().cookie).toBeUndefined();
  }
}

test("public header Search opens once and Escape restores its visible trigger", async ({ page }) => {
  const requests = recordMetadata(page);
  await openPage(page, "/guides");
  const trigger = page.getByRole("button", { name: "Search SC2 Tools", exact: true });
  await expect(trigger).toBeVisible();
  await twoFrames(page);
  expect(requests).toHaveLength(0);
  await trigger.click();
  await expect(palette(page)).toHaveCount(1);
  await expect(query(page)).toBeFocused();
  await query(page).press("Escape");
  await expect(palette(page)).toHaveCount(0);
  await expect(trigger).toBeFocused();
});

test("real guide form finds 12-pool aliases while unpublished Carrier stays disabled", async ({ page }) => {
  await openPage(page, "/guides/pvz");
  await submitGuide(page, "12pool");
  await ready(page);
  const counter = palette(page).getByRole("group", { name: "How to beat", exact: true })
    .getByRole("option").filter({ has: page.getByText("12 Pool", { exact: true }) });
  for (const alias of ["12pool", "12 pool", "beat 12 pool", "how to beat 12 pool"]) {
    await query(page).fill(`${alias} pvz`);
    await expect(counter).toHaveCount(1);
    await expect(counter).not.toHaveAttribute("aria-disabled", "true");
    await expect(counter).toContainText("PvZ");
  }
  await query(page).fill("carrier pvz");
  const carrier = palette(page).getByRole("group", { name: "Openers", exact: true })
    .getByRole("option", { name: /^Carrier Rush\b/ });
  await expect(carrier).toHaveAttribute("aria-disabled", "true");
  await expect(carrier).toContainText("Not enough games yet");
  expect(await palette(page).locator('[role="option"]:not([aria-disabled="true"])').count()).toBe(0);
  const before = page.url();
  await query(page).press("Enter");
  await expect(palette(page)).toBeVisible();
  expect(page.url()).toBe(before);
  await query(page).fill("beat 12 pool pvz");
  await expect(counter).not.toHaveAttribute("aria-disabled", "true");
  await query(page).press("Enter");
  await expect(page).toHaveURL(/\/guides\/pvz\/counter\/12-pool$/);
  await expect(palette(page)).toHaveCount(0);
  await expect(page.getByRole("heading", { name: "How to beat 12 Pool", exact: true, level: 1 })).toBeVisible();
});

test("published map discovery keeps typed queries off the network and out of storage", async ({ page }) => {
  const requests = recordMetadata(page), urls: string[] = [];
  page.on("request", request => urls.push(request.url()));
  await page.addInitScript(() => {
    const writes: string[] = [];
    Object.defineProperty(window, "__b1SearchWrites", { value: writes });
    const original = Storage.prototype.setItem;
    Storage.prototype.setItem = function (this: Storage, key: string, value: string) {
      writes.push(`${key}:${value}`);
      return original.call(this, key, value);
    };
  });
  await openPage(page, "/guides");
  await submitGuide(page, "Fixture Station LE");
  await ready(page);
  const map = palette(page).getByRole("group", { name: "Maps", exact: true })
    .getByRole("option", { name: /^Fixture Station LE\b/ });
  await expect(map).not.toHaveAttribute("aria-disabled", "true");
  expect(requests).toHaveLength(2);
  await query(page).fill(SENTINEL);
  await expect(palette(page).getByRole("status")).toContainText("No matching results");
  await twoFrames(page);
  expect(requests).toHaveLength(2);
  expect(urls.join("\n")).not.toContain(SENTINEL);
  const storage = await page.evaluate(() => ({
    writes: (window as unknown as { __b1SearchWrites: string[] }).__b1SearchWrites,
    local: Object.entries(localStorage), session: Object.entries(sessionStorage),
  }));
  expect(JSON.stringify(storage)).not.toContain(SENTINEL);
  anonymousMetadata(requests);
  await query(page).fill("Fixture Station LE");
  await expect(map).not.toHaveAttribute("aria-disabled", "true");
  await query(page).press("Enter");
  await expect(page).toHaveURL(/\/guides\/maps\/fixture-station-le$/);
  await expect(page.getByRole("heading", { name: "Fixture Station LE", exact: true, level: 1 })).toBeVisible();
});

test("real public guide transport recovers only through explicit Retry after a fixed 503 pair", async ({ page }) => {
  const requests = recordMetadata(page), pending = new Map<string, Route>();
  let firstPair = true, release!: () => void;
  const released = new Promise<void>(resolve => { release = resolve; });
  const matcher = (url: URL) => isMetadataUrl(url);
  const intercept = async (route: Route) => {
    if (route.request().method() !== "GET" || !firstPair) return route.continue();
    const path = new URL(route.request().url()).pathname;
    if (pending.has(path)) throw new Error("Duplicate public metadata request in initial pair");
    pending.set(path, route);
    if (pending.size < 2) { await released; return; }
    firstPair = false;
    const pair = [...pending.values()]; pending.clear();
    try {
      await Promise.all(pair.map(item => item.fulfill({ status: 503,
        headers: { "access-control-allow-origin": "*", "cache-control": "no-store" },
        json: { error: "synthetic_global_search_unavailable" },
      })));
    } finally { release(); }
  };
  await page.route(matcher, intercept);
  try {
    await openPage(page, "/guides/pvz");
    await submitGuide(page, "12pool");
    const retry = palette(page).getByRole("button", { name: "Retry guide availability", exact: true });
    await expect(retry).toBeVisible();
    expect(requests).toHaveLength(2);
    const unavailable = palette(page).getByRole("group", { name: "How to beat", exact: true })
      .getByRole("option").filter({ has: page.getByText("12 Pool", { exact: true }) });
    await expect(unavailable).toHaveAttribute("aria-disabled", "true");
    await expect(unavailable).toContainText("Guide availability unavailable");
    await query(page).fill("carrier pvz");
    await twoFrames(page);
    expect(requests).toHaveLength(2);
    await query(page).fill("12pool pvz");
    await retry.click();
    await ready(page);
    await expect(unavailable).not.toHaveAttribute("aria-disabled", "true");
    expect(requests).toHaveLength(4);
    expect(requests.map(request => new URL(request.url()).pathname).sort()).toEqual([
      "/v1/guides", "/v1/guides", "/v1/guides/sitemap", "/v1/guides/sitemap",
    ]);
    anonymousMetadata(requests);
  } finally {
    release();
    await Promise.all([...pending.values()].map(route => route.abort().catch(() => undefined)));
    pending.clear();
    await page.unroute(matcher, intercept);
  }
});
