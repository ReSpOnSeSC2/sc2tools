import { expect, test, type Page } from "@playwright/test";
import { checkAccessibility } from "./accessibility-check";
import { openTodayStatHeightFixture } from "./today-stat-height-fixture.mjs";

type TodayWindow = typeof window & { todayFixtureRequests: string[]; todayFixtureFilterWrites: unknown[] };

async function geometry(page: Page) {
  return page.getByTestId("dashboard-kpi-strip").evaluate(grid => {
    const cards = Array.from(grid.children) as HTMLElement[];
    const rects = cards.map(card => card.getBoundingClientRect());
    const stats = cards.slice(1).map(card => {
      const box = card.getBoundingClientRect(), style = getComputedStyle(card);
      const children = Array.from(card.children).map(child => child.getBoundingClientRect());
      return { height: box.height, top: box.top, bottom: box.bottom,
        contentHeight: Math.max(...children.map(child => child.bottom)) - box.top + parseFloat(style.paddingBottom) + parseFloat(style.borderBottomWidth) };
    });
    const overflow: string[] = [];
    for (const card of cards.slice(1)) {
      const border = card.getBoundingClientRect();
      if (card.scrollWidth > card.clientWidth + 1) overflow.push(card.textContent ?? "");
      const walker = document.createTreeWalker(card, NodeFilter.SHOW_TEXT);
      while (walker.nextNode()) {
        const node = walker.currentNode, parent = node.parentElement;
        if (!node.textContent?.trim() || !parent || parent.closest(".sr-only")) continue;
        const range = document.createRange(); range.selectNodeContents(node);
        if (Array.from(range.getClientRects()).some(line => line.left < border.left + 1 || line.right > border.right - 1 || line.top < border.top + 1 || line.bottom > border.bottom - 1)) overflow.push(node.textContent);
      }
    }
    return { cards: rects.map(box => ({ top: box.top, bottom: box.bottom, left: box.left, right: box.right, width: box.width, height: box.height })),
      stats, overflow, columns: getComputedStyle(grid).gridTemplateColumns.split(" ").length,
      horizontalOverflow: document.documentElement.scrollWidth > innerWidth };
  });
}

for (const theme of ["light", "dark"] as const) {
  test(`Today ${theme}: mobile statistics fit their content with populated, empty and loading sessions`, async ({ page }, info) => {
    test.setTimeout(120_000);
    const evidence = await openTodayStatHeightFixture(page, { theme });
    const widths = info.project.name === "mobile-360" ? [320, 390] : [info.project.name === "tablet-768" ? 768 : 1280];
    const observations = [];
    for (const width of widths) {
      await page.setViewportSize({ width, height: 1000 });
      for (const state of ["populated", "empty", "loading"]) {
        await evidence.showState(state);
        const strip = page.getByTestId("dashboard-kpi-strip"), session = page.getByTestId("kpi-today-session");
        // The record is a text node in the same hint as the timeframe span.
        // Match that complete hint instead of inventing a standalone element.
        const winRateHint = strip.getByText("Own timeframe · ignores date, matchup, region and Strategies filters", { exact: true }).locator("..");
        await expect(winRateHint).toBeVisible();
        await expect(strip.getByText("Active streak", { exact: true })).toBeVisible();
        await expect(strip.getByText("MMR", { exact: true })).toBeVisible();
        await expect(strip.getByText("Games in range", { exact: true })).toBeVisible();
        await expect(strip.getByText("Uses filters · Season 68 · 2 more filters", { exact: true })).toBeVisible();
        if (state === "populated") {
          await expect(strip.getByText("58.1%", { exact: true })).toBeVisible();
          await expect(winRateHint).toHaveText(/^161–116 over 277 games\s*Own timeframe · ignores date, matchup, region and Strategies filters$/);
          for (const value of ["W2", "5468", "5224", "350"]) await expect(strip.getByText(value, { exact: true })).toBeVisible();
          await expect(session.getByRole("link", { name: "View this session", exact: true })).toBeVisible();
        } else if (state === "empty") {
          await expect(session.getByText("No session in the current view", { exact: true })).toBeVisible();
          await expect(winRateHint).toHaveText(/^No games in this window\s*Own timeframe · ignores date, matchup, region and Strategies filters$/);
          await expect(strip.getByRole("link", { name: "Add a Pulse ID in Settings", exact: true })).toHaveAttribute("href", "/settings?tab=profile#pulse-id-help");
        } else {
          await expect(session.getByRole("status")).toHaveText("Loading session view…");
          await expect(session.getByText("No session in the current view", { exact: true })).toHaveCount(0);
          await expect(winRateHint).not.toContainText("No games in this window");
          await expect(strip.getByText("Tied or no recent games", { exact: true })).toHaveCount(0);
        }
        const layout = await geometry(page);
        expect(layout.cards).toHaveLength(5); expect(layout.overflow).toEqual([]); expect(layout.horizontalOverflow).toBe(false);
        if (width < 1024) {
          expect(layout.columns).toBe(2);
          expect(layout.cards[0].width).toBeGreaterThan(layout.cards[1].width * 1.9);
          expect(layout.cards[1].top).toBe(layout.cards[2].top);
          expect(layout.cards[3].top).toBe(layout.cards[4].top);
          expect(layout.cards[1].top).toBeGreaterThan(layout.cards[0].bottom);
          expect(layout.cards[3].top).toBeGreaterThan(layout.cards[1].bottom);
          for (const row of [layout.stats.slice(0, 2), layout.stats.slice(2)]) {
            // Each pair may align; spare height must come only from its own
            // tallest content, never from the full-width session above it.
            expect(Math.max(...row.map(card => card.height)) - Math.max(...row.map(card => card.contentHeight))).toBeLessThanOrEqual(1.5);
          }
        } else {
          expect(layout.columns).toBe(5);
          expect(Math.max(...layout.cards.map(card => card.top)) - Math.min(...layout.cards.map(card => card.top))).toBeLessThanOrEqual(1);
          expect(Math.max(...layout.cards.map(card => card.height)) - Math.min(...layout.cards.map(card => card.height))).toBeLessThanOrEqual(1);
        }
        observations.push({ width, state, ...layout });
        await checkAccessibility(page, info, `/today-stat-height-${width}-${state}`, theme);
        await info.attach(`today-stats-${theme}-${width}-${state}`, { body: await page.screenshot({ fullPage: true }), contentType: "image/png" });
        const writes = await page.evaluate(() => (window as TodayWindow).todayFixtureFilterWrites);
        expect(writes).toEqual([]);
      }
      await evidence.showState("populated");
      const launcher = page.getByRole("button", { name: "Change Win Rate timeframe", exact: true });
      await launcher.click(); await expect(page.getByRole("menu", { name: "Win rate timeframe", exact: true })).toBeVisible();
      await page.keyboard.press("Escape"); await expect(launcher).toBeFocused();
      await expect(page.getByRole("menu", { name: "Win rate timeframe", exact: true })).toHaveCount(0);
      const keys = await page.evaluate(() => [...new Set((window as TodayWindow).todayFixtureRequests)]);
      expect(keys).toHaveLength(5);
      expect(keys.filter(key => !key.startsWith("/v1/me/mmr")).every(key => key.endsWith("#7"))).toBe(true);
      expect(keys.find(key => key.startsWith("/v1/sessions/current"))).not.toMatch(/regions=|min_minutes=|max_minutes=/);
      const range = keys.find(key => key.startsWith("/v1/timeseries") && key.includes("interval=month"));
      expect(range).toContain("regions=NA%2CEU"); expect(range).toContain("min_minutes=10"); expect(range).toContain("max_minutes=20");
    }
    expect(evidence.errors).toEqual([]); expect(evidence.unexpectedRequests).toEqual([]);
    await info.attach("today-stat-sizing-and-boundaries", { body: JSON.stringify({ observations, errors: evidence.errors, unexpectedRequests: evidence.unexpectedRequests }), contentType: "application/json" });
  });
}
