import { expect, test } from "@playwright/test";
import axe from "axe-core";

/** Real Next route; only synthetic token APIs, no connected chat providers. */
test("Dock disclosures preserve drafts and pass automated accessibility checks", async ({ page }) => {
  await page.route("**/v1/multichat/e2e-synthetic-dock/**", route => {
    const path = new URL(route.request().url()).pathname;
    const data = path.endsWith("/config") ? { config: {} }
      : path.endsWith("/studio") ? { highlight: null, goals: [], poll: null, scene: null, timer: null, blockedUsers: [] }
      : path.endsWith("/viewers") ? { platforms: [] }
      : { clipMoments: [] };
    return route.fulfill({ status: 200, headers: { "Access-Control-Allow-Origin": "*" }, contentType: "application/json", body: JSON.stringify(data) });
  });
  await page.route("**/socket.io/**", route => route.abort());
  await page.goto("/dock/e2e-synthetic-dock");
  const draft = page.getByPlaceholder("Poll question");
  await expect(draft).toBeVisible(); await draft.fill("Next build?");
  await page.getByRole("button", { name: "Poll", exact: true, expanded: true }).click();
  await expect(draft).toBeHidden();
  await page.getByRole("button", { name: "Pin Poll to top", exact: true }).click();
  await expect(page.locator("[data-dock-section]").first()).toHaveAttribute("id", "dock-poll");
  await page.getByRole("button", { name: "Reset layout", exact: true }).click();
  await expect(draft).toHaveValue("Next build?");
  const timerDraft = page.getByPlaceholder("Optional label — e.g. next game in…");
  await timerDraft.fill("Keep timer draft");
  let rejectedChunk = false;
  await page.route("**/_next/static/chunks/*.js", route => {
    if (!rejectedChunk) { rejectedChunk = true; return route.abort(); }
    return route.continue();
  });
  await page.getByRole("button", { name: "Build vote", exact: true }).click();
  await expect(page.getByRole("button", { name: "Retry build vote", exact: true })).toBeVisible();
  await expect(timerDraft).toHaveValue("Keep timer draft");
  await page.getByRole("button", { name: "Retry build vote", exact: true }).click();
  await expect(page.getByText(/No saved builds yet/)).toBeVisible();
  await expect(page.getByRole("button", { name: "Build vote", exact: true })).toHaveAttribute("aria-pressed", "true");
  await expect(timerDraft).toHaveValue("Keep timer draft");
  expect(rejectedChunk).toBe(true);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.addScriptTag({ content: axe.source });
  const violations = await page.evaluate(async () => {
    const runner = (window as typeof window & { axe: typeof axe }).axe;
    const result = await runner.run(document, { runOnly: { type: "tag", values: ["wcag2a", "wcag2aa", "wcag21aa"] } });
    return result.violations.map(issue => ({ id: issue.id, impact: issue.impact, nodes: issue.nodes.map(node => node.target) }));
  });
  expect(violations).toEqual([]);
});
