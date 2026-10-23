import { expect, test } from "@playwright/test";

test("definition links reveal hidden rules, preserve URL filters and fit the viewport", async ({ page }, testInfo) => {
  await page.goto("/");
  const reject = page.getByRole("button", { name: "Reject", exact: true });
  await reject.click();
  const response = await page.goto("/definitions?q=impossible&race=T#zerg-12-pool");
  expect(response?.status()).toBe(200);
  const pool = page.getByRole("heading", { name: "Zerg - 12 Pool", exact: true });
  await expect(pool).toBeFocused();
  await expect(page.getByRole("textbox", { name: "Search builds and strategies" })).toHaveValue("");
  const matchup = page.getByRole("group", { name: "Filter by matchup", exact: true });
  await expect(matchup.getByRole("button")).toHaveCount(10);
  await matchup.getByRole("button", { name: "ZvT", exact: true }).click();
  await expect(page).toHaveURL(/race=Z&matchup=ZvT#zerg-12-pool$/);
  await expect(matchup.getByRole("button", { name: "ZvT", exact: true })).toHaveAttribute("aria-pressed", "true");
  await page.getByRole("textbox", { name: "Search builds and strategies" }).fill("8 pool");
  await expect(page).toHaveURL(/q=8\+pool&race=Z&matchup=ZvT#zerg-12-pool$/);
  await page.reload();
  await expect(page.getByRole("textbox", { name: "Search builds and strategies" })).toHaveValue("8 pool");
  const filterNavigations: string[] = [];
  page.on("request", (request) => {
    const url = new URL(request.url());
    if (url.pathname === "/definitions" && (request.isNavigationRequest() || request.headers().rsc === "1")) filterNavigations.push(request.url());
  });
  await page.getByRole("group", { name: "Filter by race", exact: true }).getByRole("button", { name: "Terran", exact: true }).click();
  await expect(pool).toHaveCount(0);
  await page.evaluate(() => { window.location.hash = "pvz-stargate-into-glaives"; });
  const revealed = page.getByRole("heading", { name: "PvZ - Stargate into Glaives", exact: true });
  await expect(revealed).toBeFocused();
  await expect(page.locator("#pvz-stargate-into-glaives")).toHaveClass(/ring-2/);
  // Repeated hash reveals must win over rapid local filter edits; no
  // server navigation is needed because the complete catalog is local.
  for (const [id, name] of [
    ["zerg-12-pool", "Zerg - 12 Pool"], ["pvz-stargate-into-glaives", "PvZ - Stargate into Glaives"],
    ["zerg-12-pool", "Zerg - 12 Pool"], ["pvz-stargate-into-glaives", "PvZ - Stargate into Glaives"],
  ]) {
    await page.getByRole("textbox", { name: "Search builds and strategies" }).fill("impossible");
    await page.getByRole("group", { name: "Filter by race", exact: true }).getByRole("button", { name: "Terran", exact: true }).click();
    await page.evaluate((target) => { window.location.hash = target; }, id);
    await expect(page.getByRole("heading", { name, exact: true })).toBeFocused();
    await expect(page.getByRole("textbox", { name: "Search builds and strategies" })).toHaveValue("");
    await expect(page).toHaveURL(new RegExp(`/definitions#${id}$`));
  }
  expect(filterNavigations).toEqual([]);
  expect(await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)).toBeLessThanOrEqual(1);
  await page.screenshot({ path: testInfo.outputPath(`definitions-${testInfo.project.name}.png`) });
});

test("Back and Forward accept copied percent-encoded multiword definition filters", async ({ page }) => {
  await page.goto("/definitions");
  const search = page.getByRole("textbox", { name: "Search builds and strategies" });
  await expect(search).toBeVisible();
  const terran = page.getByRole("group", { name: "Filter by race", exact: true }).getByRole("button", { name: "Terran", exact: true });
  await terran.click();
  await expect(terran).toHaveAttribute("aria-pressed", "true");
  await expect(page).toHaveURL(/\/definitions\?race=T$/);
  // Retain the current entry's router state to emulate existing browser
  // history entries with copied URLs, without pre-normalizing their query.
  await page.evaluate(() => {
    const state = window.history.state;
    window.history.pushState(state, "", "/definitions?q=Stargate%20into%20Glaives&race=P&tracking=%E2%9C%93");
    window.history.pushState(state, "", "/definitions?q=Robo%20Opener&race=P");
  });
  await page.goBack();
  await expect(search).toHaveValue("Stargate into Glaives");
  await expect(page.getByRole("heading", { name: "PvZ - Stargate into Glaives", exact: true })).toBeVisible();
  await page.goForward();
  await expect(search).toHaveValue("Robo Opener");
  await expect(page.getByRole("heading", { name: "PvZ - Robo Opener", exact: true })).toBeVisible();
  await expect(page.getByRole("group", { name: "Filter by race", exact: true }).getByRole("button", { name: "Protoss", exact: true })).toHaveAttribute("aria-pressed", "true");
});
