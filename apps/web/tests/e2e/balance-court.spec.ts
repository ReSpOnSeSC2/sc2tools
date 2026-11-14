import AxeBuilder from "@axe-core/playwright";
import { expect, test, type Page } from "@playwright/test";
import { INSTANT_DB_NAME, INSTANT_DB_VERSION, TRY_GAMES_EXPIRES_INDEX } from "../../lib/instant/idb";
import { BALANCE_EVIDENCE_HEADERS, BALANCE_EVIDENCE_ROUTE, balanceEvidenceFixture } from "./balance-evidence-fixture";

const game = {
  gameId: "private-replay-id", date: "2026-10-29T12:00:00Z", result: "Defeat", durationSec: 344,
  myRace: "Terran", myMmr: 3500, myToonHandle: "1-S2-1-123456", isLadderGame: true, map: "Test map",
  opponent: { race: "Protoss", displayName: "Private opponent", leagueId: 4 },
  macroBreakdown: { raw: { supply_blocked_seconds: 20, opp_supply_block_windows: [] } },
};

async function seedLoss(page: Page) {
  await page.evaluate(async ({ name, version, index, game }) => {
    const db = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open(name, version);
      request.onupgradeneeded = () => {
        request.result.createObjectStore("tryGames", { keyPath: "gameId" }).createIndex(index, "expiresAt");
        request.result.createObjectStore("ledger", { keyPath: "path" });
        request.result.createObjectStore("handles");
        request.result.createObjectStore("meta");
      };
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    try {
      await new Promise<void>((resolve, reject) => {
        const write = db.transaction("tryGames", "readwrite");
        const now = Date.now();
        write.objectStore("tryGames").put({ gameId: game.gameId, date: game.date,
          storedAt: now, expiresAt: now + 600_000, json: JSON.stringify(game) });
        write.oncomplete = () => resolve();
        write.onabort = () => reject(write.error);
      });
    } finally {
      db.close();
    }
  }, { game, name: INSTANT_DB_NAME, version: INSTANT_DB_VERSION, index: TRY_GAMES_EXPIRES_INDEX });
}

test("replay verdict stays local and shares only its pinned ladder evidence", async ({ page }) => {
  test.skip(process.env.NEXT_PUBLIC_INSTANT_IMPORT !== "all", "requires the public /try build");
  const evidence = balanceEvidenceFixture();
  const diamond = evidence.tiers.find(tier => tier.league === "diamond" && tier.division === 1);
  diamond?.bounds.push({ region: "US", minRating: 3400, maxRating: 3799 });
  const evidenceQueries: string[] = [];
  await page.route(BALANCE_EVIDENCE_ROUTE, async route => {
    const request = route.request();
    expect(request.method()).toBe("GET");
    expect(request.postData()).toBeNull();
    evidenceQueries.push(new URL(request.url()).search);
    await route.fulfill({ json: evidence, headers: BALANCE_EVIDENCE_HEADERS });
  });
  const privateTraffic: string[] = [];
  page.on("request", request => {
    const possibleLeak = `${request.url()}\n${request.postData() ?? ""}`;
    if (/private-replay-id|Private(?: |%20|\+)opponent|1-S2-1-123456|2026-10-29/.test(possibleLeak)) privateTraffic.push(request.url());
  });
  await page.addInitScript(() => {
    Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText: async (value: string) => {
      sessionStorage.setItem("copied-verdict", value);
    } } });
  });
  await page.goto("/try#balance-court");
  await page.getByRole("button", { name: "Reject", exact: true }).click();
  const court = page.getByRole("region", { name: "Balance Court" });
  await expect(court.getByRole("link", { name: "Add a ranked 1v1 loss" })).toBeVisible();
  await seedLoss(page);
  await page.reload();
  await court.getByRole("button", { name: "Review a loss" }).click();
  await expect(court.getByRole("combobox", { name: "Ladder cohort" })).toHaveValue("diamond-1");
  await expect(court.getByRole("heading", { name: "Mirror test" })).toBeVisible();
  await expect(court.getByText(/latest available ladder snapshot/i)).toBeVisible();
  await court.getByRole("checkbox", { name: "Use Test map only" }).check();
  await expect(court.getByRole("heading", { name: "Imba", exact: true })).toBeVisible();
  await expect(court.getByText(/99% interval/)).toBeVisible();
  await expect(court.getByText(/Ladder.s share of the blame/)).toContainText("16.7%");
  await court.getByRole("button", { name: "Copy link" }).click();
  await expect(court.getByRole("button", { name: "Link copied" })).toBeVisible();
  const shared = await page.evaluate(() => sessionStorage.getItem("copied-verdict"));
  expect(shared).toMatch(/\/balance\/verdict#verdict=imba&season=68&asOf=2026-11-13&race=T&opponent=P&cohort=diamond-1&map=5$/);
  expect(shared).not.toMatch(/private|123456|2026-10-29/i);
  const issues = await new AxeBuilder({ page }).include("#balance-court").withTags(["wcag2a", "wcag2aa", "wcag21aa"]).analyze();
  expect(issues.violations.filter(issue => issue.impact === "serious" || issue.impact === "critical")).toEqual([]);
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(await page.evaluate(() => document.documentElement.clientWidth));
  await page.goto(shared!);
  await expect(page.getByRole("heading", { name: "Imba", exact: true })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Replay exhibits" })).toHaveCount(0);
  await expect(page.getByText("Private opponent")).toHaveCount(0);
  expect(evidenceQueries).toEqual(["", "?season=68&asOf=2026-11-13"]);
  expect(privateTraffic).toEqual([]);
});
