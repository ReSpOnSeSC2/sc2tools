import { expect, test } from "@playwright/test";

test("Large themed playground frames cards without cropping full-canvas sources or widening the page", async ({ page }) => {
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.goto("/stream-studio/playground");
  const playground = page.getByRole("region", { name: "Widget playground" });
  await playground.getByRole("combobox", { name: /^Widget$/ }).selectOption("all");
  await playground.getByRole("combobox", { name: "Theme preset" }).selectOption("arena-broadcast");
  await playground.getByRole("combobox", { name: "Scale" }).selectOption("1.25");

  const poll = playground.getByRole("img", { name: /^Chat poll,.*sample preview$/ });
  const card = poll.locator('[data-overlay-panel="framed"]');
  await expect(card).toHaveCSS("zoom", "1.25");
  await expect(card).not.toHaveCSS("clip-path", "none");
  const ticker = playground.getByRole("img", { name: /^Stats ticker,.*sample preview$/ });
  const strip = ticker.locator('[data-overlay-panel="plain"]');
  await expect(strip).toHaveCSS("zoom", /^(?:1|normal)$/);
  await expect(strip).toHaveCSS("clip-path", "none");
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1)).toBe(true);
});

test("a dedicated overlay source loads its local sample after route hydration", async ({ page }) => {
  let connections = 0;
  page.on("websocket", () => { connections += 1; });
  await page.goto("/overlay/local-sample/widget/opponent?demo=1");
  await expect(page.getByRole("status").filter({ hasText: "Local preview · sample data" })).toBeVisible();
  await expect(page.getByText("TestOpponent", { exact: true })).toBeVisible();
  expect(connections).toBe(0);
});

test("a composite overlay sample keeps its card order without connecting", async ({ page }) => {
  let connections = 0;
  page.on("websocket", () => { connections += 1; });
  await page.goto("/overlay/local-sample?demo=1");
  await expect(page.getByRole("status").filter({ hasText: "Local preview · sample data" })).toBeVisible();
  const cards = page.locator('[data-overlay-layer="test"] [data-layout-widget]');
  await expect(cards).toHaveCount(17);
  expect(await cards.evaluateAll(nodes => nodes.map(node => node.getAttribute("data-layout-widget")))).toEqual([
    "opponent", "match-result", "post-game", "mmr-delta", "streak", "cheese", "rematch", "rival",
    "rank", "meta", "topbuilds", "fav-opening", "best-answer", "scouting", "session", "randomizer", "series",
  ]);
  expect(connections).toBe(0);
});

test("a composite source loads the recovery card after a terminal handshake", async ({ page }) => {
  await page.routeWebSocket(/\/socket\.io\//u, socket => {
    socket.onMessage(message => {
      if (typeof message === "string" && message.startsWith("40")) {
        socket.send('44{"message":"invalid_overlay_token"}');
      }
    });
    socket.send('0{"sid":"fixture","upgrades":[],"pingInterval":25000,"pingTimeout":20000,"maxPayload":1000000}');
  });
  await page.goto("/overlay/fixture-invalid?check=1");
  await expect(page.getByText("This overlay link no longer works")).toBeVisible();
  await expect(page.getByText("Link invalid", { exact: true })).toBeVisible();
});
