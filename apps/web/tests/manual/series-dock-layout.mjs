// Local synthetic Series state; real Dock controls, scoreboard, CSS and fonts.
// Run from apps/web with PW_CHROMIUM_EXECUTABLE pointing at an installed browser.
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { chromium, expect } from "@playwright/test";
import { startSeriesFixture } from "./series-mode-fixture.mjs";

const executablePath = process.env.PW_CHROMIUM_EXECUTABLE;
assert.ok(executablePath, "Use the installed Chromium; do not download a browser");
const output = process.env.SERIES_LAYOUT_OUTPUT;
assert.ok(output, "Choose a new evidence directory");
await fs.mkdir(output, { recursive: false });
const fixture = await startSeriesFixture();
let browser;
const base = "http://127.0.0.1:4328";
const results = [], errors = [], external = [];
try {
  browser = await chromium.launch({ executablePath, headless: true });
  for (const width of [248, 390, 1280]) for (const theme of ["light", "dark"]) {
    const context = await browser.newContext({ viewport: { width, height: 1000 }, colorScheme: theme, reducedMotion: "reduce" });
    await context.route("**/*", route => {
      if (new URL(route.request().url()).origin === base) return route.continue();
      external.push(route.request().url()); return route.abort();
    });
    const page = await context.newPage();
    page.on("pageerror", error => errors.push(error.message));
    await context.request.post(`${base}/__series/reset`);
    const started = await context.request.post(`${base}/fixture-api/v1/multichat/synthetic-series/series`, {
      data: { action: "start", revision: 0, opponentName: "Stradrozer", format: 3, maps: [] },
    });
    assert.equal(started.status(), 200);
    await page.goto(`${base}/?theme=${theme}`);
    await page.evaluate(() => document.fonts.ready);
    const panel = page.getByRole("region", { name: "Series controls", exact: true });
    const score = panel.getByLabel("Bo3 series score");
    await expect(score).toBeVisible();
    await expect(panel.getByRole("link", { name: "How Series works", exact: true })).toBeVisible();
    await panel.getByRole("button", { name: "Add a win for you", exact: true }).click();
    await expect(score.locator("strong")).toHaveText("1–0");
    await panel.getByRole("button", { name: "Remove a win for you", exact: true }).click();
    await expect(score.locator("strong")).toHaveText("0–0");
    const measure = () => panel.evaluate(panel => {
      const rect = element => { const { left, right, top, bottom, width, height } = element.getBoundingClientRect(); return { left, right, top, bottom, width, height }; };
      const scoreboard = panel.querySelector('[aria-label="Bo3 series score"]');
      return {
        viewport: innerWidth, body: document.documentElement.scrollWidth,
        panel: rect(panel), score: rect(scoreboard.querySelector("strong")),
        names: [...scoreboard.querySelectorAll(".font-semibold")].map(rect),
        buttons: [...panel.querySelectorAll("button")].filter(element => element.getBoundingClientRect().width).map(element => ({ text: element.textContent, ...rect(element) })),
      };
    });
    const assertGeometry = geometry => {
      assert.ok(geometry.body <= width + 1, JSON.stringify(geometry));
      for (const button of geometry.buttons) {
        assert.ok(button.left >= geometry.panel.left - 1 && button.right <= geometry.panel.right + 1, JSON.stringify(button));
      }
      for (const name of geometry.names) {
        const overlapX = Math.min(name.right, geometry.score.right) - Math.max(name.left, geometry.score.left);
        const overlapY = Math.min(name.bottom, geometry.score.bottom) - Math.max(name.top, geometry.score.top);
        assert.ok(overlapX <= 1 || overlapY <= 1, JSON.stringify({ name, score: geometry.score }));
      }
    };
    const normal = await measure(); assertGeometry(normal);
    await panel.screenshot({ path: path.join(output, `series-dock-${theme}-${width}.png`) });
    const current = await (await context.request.get(`${base}/__series/state`)).json();
    await context.request.post(`${base}/fixture-api/v1/multichat/synthetic-series/series`, {
      data: { action: "end", revision: current.snapshot.revision },
    });
    const ended = await (await context.request.get(`${base}/__series/state`)).json();
    await page.evaluate(value => window.seriesFixture.emit(value), { ...ended.snapshot, opponentName: "W".repeat(80), revision: ended.snapshot.revision + 1 });
    await expect(score).toContainText("ENDED");
    await expect(panel.getByRole("button", { name: "Add a win for you", exact: true })).toBeDisabled();
    const longName = await measure(); assertGeometry(longName);
    await panel.screenshot({ path: path.join(output, `series-dock-${theme}-${width}-ended-long-name.png`) });
    results.push({ width, theme, normal, longName });
    await context.close();
  }
  assert.deepEqual(errors, []); assert.deepEqual(external, []);
  await fs.writeFile(path.join(output, "result.json"), JSON.stringify({ results, errors, external }, null, 2));
  console.log(JSON.stringify({ cases: results.length, captures: results.length * 2, errors, external }));
} finally {
  await browser?.close();
  await fixture.close();
}
