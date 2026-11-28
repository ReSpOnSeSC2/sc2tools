import { expect, test, type Page } from "@playwright/test";
import { checkAccessibility } from "./accessibility-check";

const API = "**/v1/live-streams";
const headers = { "access-control-allow-origin": "*" };

const stream = (n: number, platform: "twitch" | "kick", language: string, viewers: number) => ({
  id: `${platform}:${n}`, platform, channel: `Channel${n}`, title: `Ladder grind with channel ${n}`, language, viewers,
  startedAt: new Date(Date.now() - 95 * 60_000).toISOString(),
  url: platform === "twitch" ? `https://www.twitch.tv/channel${n}` : `https://kick.com/channel${n}`,
});
const snapshot = (streams: ReturnType<typeof stream>[]) => ({
  streams, platforms: { twitch: "ok", kick: "ok" }, fetchedAt: new Date().toISOString(),
});
const LIST = [stream(1, "twitch", "en", 480), stream(2, "kick", "pt", 12), stream(3, "twitch", "ko", 150), stream(4, "twitch", "en", 3)];

const cardTitles = (page: Page) => page.getByRole("main").getByRole("heading", { level: 3 }).evaluateAll(nodes => nodes.map(node => node.textContent?.replace(/ \(opens.*$/, "")));
const noSidewaysScroll = (page: Page) => page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth);

test("lists live streams, filters them and links out without a provider call", async ({ page }, info) => {
  const providerCalls: string[] = [];
  page.on("request", request => {
    if (/twitch\.tv|kick\.com/.test(new URL(request.url()).host)) providerCalls.push(request.url());
  });
  await page.route(API, route => route.fulfill({ json: snapshot(LIST), headers }));
  await page.emulateMedia({ colorScheme: "light", reducedMotion: "reduce" });
  await page.goto("/live");
  await expect(page.getByRole("heading", { level: 1, name: /Live StarCraft\s+II streams/ })).toBeVisible();
  await expect(page.getByText("4 of 4 live streams")).toBeVisible();
  expect(await cardTitles(page)).toEqual([...LIST].sort((a, b) => b.viewers - a.viewers).map(row => row.title));

  const first = page.getByRole("link", { name: /Ladder grind with channel 1/ });
  await expect(first).toHaveAttribute("href", "https://www.twitch.tv/channel1");
  await expect(first).toHaveAttribute("target", "_blank");
  await expect(page.getByText("live for 1 h 3", { exact: false }).first()).toBeVisible();

  await page.getByLabel("Order").selectOption("small");
  expect((await cardTitles(page))[0]).toBe("Ladder grind with channel 4");
  await page.getByLabel("Platform").selectOption("kick");
  expect(await cardTitles(page)).toEqual(["Ladder grind with channel 2"]);
  await page.getByLabel("Platform").selectOption("all");
  await page.getByLabel("Language").selectOption("en");
  await expect(page.getByText("2 of 4 live streams")).toBeVisible();

  await page.getByLabel("Platform").selectOption("kick");
  await expect(page.getByText("No live streams match these filters.")).toBeVisible();
  await page.getByRole("button", { name: "Show all streams" }).click();
  await expect(page.getByText("4 of 4 live streams")).toBeVisible();

  const tall = await page.getByRole("link", { name: /Ladder grind with channel 1/ }).evaluate(node => node.parentElement!.parentElement!.getBoundingClientRect().height);
  expect(tall).toBeGreaterThanOrEqual(44);
  expect(await noSidewaysScroll(page)).toBe(true);
  expect(providerCalls).toEqual([]);
  for (const theme of ["light", "dark"] as const) {
    await page.emulateMedia({ colorScheme: theme, reducedMotion: "reduce" });
    await checkAccessibility(page, info, "/live", theme);
  }
});

test("reaches a card with the keyboard", async ({ page }) => {
  await page.route(API, route => route.fulfill({ json: snapshot(LIST), headers }));
  await page.goto("/live");
  const first = page.getByRole("link", { name: /Ladder grind with channel 1/ });
  await first.focus();
  await expect(first).toBeFocused();
  await page.getByLabel("Order").focus();
  await page.keyboard.press("ArrowDown");
  await expect(page.getByLabel("Order")).toHaveValue("small");
});

test("shows an empty state and an error that can be retried", async ({ page }, info) => {
  let failing = true;
  await page.route(API, route => (failing
    ? route.fulfill({ status: 503, json: { error: { code: "live_streams_unavailable" } }, headers })
    : route.fulfill({ json: snapshot([]), headers })));
  await page.goto("/live");
  await expect(page.getByText(/unavailable right now/)).toBeVisible();
  await checkAccessibility(page, info, "/live-error", "light");
  failing = false;
  await page.getByRole("button", { name: "Retry live streams" }).click();
  await expect(page.getByText(/No StarCraft II streams are live/)).toBeVisible();
  expect(await noSidewaysScroll(page)).toBe(true);
});
