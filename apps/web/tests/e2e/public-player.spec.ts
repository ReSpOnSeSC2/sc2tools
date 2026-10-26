import { expect, test } from "@playwright/test";
import { createHash } from "node:crypto";

test("canonical player sections fit both themes and expose only selected sections", async ({ page }, info) => {
  for (const theme of ["light", "dark"]) {
    await page.addInitScript(value => localStorage.setItem("sc2tools.theme", value), theme);
    const result = await page.goto("/players/fixture-builder-0123456789");
    expect(result?.status()).toBe(200);
    await expect(page.locator("html")).toHaveAttribute("data-theme", theme);
    await expect(page.getByRole("heading", { name: "FixtureBuilder", exact: true })).toHaveCount(1);
    const sections = page.getByRole("navigation", { name: "Player sections" });
    await expect(sections.getByRole("link", { name: "overview", exact: true })).toHaveAttribute("aria-current", "page");
    await expect(sections.getByRole("link", { name: "replays", exact: true })).toHaveCount(0);
    await expect(page.getByRole("heading", { name: "Recent form", exact: true })).toBeVisible();
    const rejectCookies = page.getByRole("button", { name: "Reject", exact: true });
    if (await rejectCookies.isVisible()) await rejectCookies.click();
    await page.screenshot({ path: info.outputPath(`public-player-${theme}.png`), fullPage: true, animations: "disabled" });
    await sections.getByRole("link", { name: "builds", exact: true }).click();
    await expect(sections.getByRole("link", { name: "builds", exact: true })).toHaveAttribute("aria-current", "page");
    await expect(page.getByRole("heading", { name: "Published builds", exact: true })).toBeVisible();
    const box = await page.evaluate(() => ({ width: document.documentElement.scrollWidth, viewport: document.documentElement.clientWidth }));
    expect(box.width).toBeLessThanOrEqual(box.viewport + 1);
  }
});

test("warm Community author links disappear after profile Off without an optional purge", async ({ page, request }, info) => {
  const handle = `fixture-privacy-${createHash("sha256").update(`${info.project.name}:${info.retry}:${info.title}`).digest("hex").slice(0, 10)}`;
  const control = `http://127.0.0.1:8080/__mock/public-player/${handle}/visibility`;
  expect((await request.post(control, { data: { enabled: true } })).status()).toBe(200);
  expect((await page.goto(`/community/builds/${handle}`))?.status()).toBe(200);
  await expect(page.getByRole("link", { name: "Privacy Fixture", exact: true })).toHaveAttribute("href", `/players/${handle}`);
  // The isolated API changes consent only. It never calls Next's optional
  // purge hook, so a warm positive data/output cache would retain this link.
  expect((await request.post(control, { data: { enabled: false } })).status()).toBe(200);
  const hidden = await page.reload();
  expect(hidden?.status()).toBe(200);
  expect(await hidden!.text()).not.toContain(`/players/${handle}`);
  await expect(page.getByRole("link", { name: "Privacy Fixture", exact: true })).toHaveCount(0);
  await expect(page.getByText("Privacy Fixture", { exact: true }).filter({ visible: true })).toBeVisible();
});

test("legacy public author/profile URLs redirect directly once to the canonical page", async ({ request }) => {
  for (const legacy of ["/p/fixture-community-author", "/community/authors/fixture-community-author"]) {
    const response = await request.get(legacy, { maxRedirects: 0 });
    expect(response.status(), legacy).toBe(308);
    expect(response.headers().location).toBe("/players/fixture-builder-0123456789");
  }
  for (const root of ["/p", "/community/authors"]) {
    expect((await request.get(`${root}/missing-shared-player`, { maxRedirects: 0 })).status()).toBe(404);
    expect((await request.get(`${root}/unavailable-shared-player`, { maxRedirects: 0 })).status()).toBe(500);
  }
});

test("Community directory retains its index-only loading fallback", async ({ page }) => {
  await page.goto("/community?q=fixture-directory-loader", { waitUntil: "commit" });
  const fallback = page.getByRole("status").filter({ hasText: "Loading community builds" });
  await expect(fallback).toBeVisible();
  await expect(page.getByRole("heading", { name: "Community builds", exact: true })).toBeVisible();
  await expect(fallback).toBeHidden();
});

test("profile and panel requests admit fresh privacy state after a previous public render", async ({ page, request }, info) => {
  const handle = `fixture-privacy-${createHash("sha256").update(`${info.project.name}:${info.retry}:${info.title}`).digest("hex").slice(0, 10)}`;
  const control = `http://127.0.0.1:8080/__mock/public-player/${handle}/visibility`;
  expect((await request.post(control, { data: { enabled: true } })).status()).toBe(200);
  const first = await page.goto(`/players/${handle}`); expect(first?.status()).toBe(200);
  await expect(page.getByRole("heading", { name: "Privacy Fixture", exact: true })).toBeVisible();
  const personal = await request.get(`/players/${handle}/panel.png?style=record&height=160`);
  expect(personal.headers()["cache-control"]).toContain("no-store");
  const before = await personal.body();
  expect((await request.post(control, { data: { enabled: false } })).status()).toBe(200);
  const hidden = await page.reload(); expect(hidden?.status()).toBe(404);
  await expect(page.getByRole("heading", { name: "Privacy Fixture", exact: true })).toHaveCount(0);
  const neutral = await request.get(`/players/${handle}/panel.png?style=record&height=160`);
  expect(neutral.status()).toBe(200); expect(neutral.headers()["cache-control"]).toContain("no-store");
  const after = await neutral.body();
  expect([after.readUInt32BE(16), after.readUInt32BE(20)]).toEqual([320, 160]);
  expect(after.equals(before)).toBe(false);
});
