import AxeBuilder from "@axe-core/playwright";
import { expect, test, type Page } from "@playwright/test";
import reference from "../../lib/instant/pace-reference.json";
import { INSTANT_DB_NAME, INSTANT_DB_VERSION, TRY_GAMES_EXPIRES_INDEX } from "../../lib/instant/idb";
import { readPaceReference } from "../../lib/instant/paceReference";
import { captureAccessibility } from "./accessibility-check";

const REGION = "Pace gap versus a 5,300-MMR reference";
const SUPPORTED = readPaceReference(reference).some(({ matchup, era }) => matchup === "PvT" && era === "after");
const REVERSE = readPaceReference(reference).some(({ matchup, era }) => matchup === "TvP" && era === "after");
const ECONOMY = Array.from({ length: 28 }, (_, i) => ({
  time: i * 10, food_workers: 12 + Math.max(0, i - 2),
  minerals_collection_rate: 516, vespene_collection_rate: 60,
}));

function game(key: string, day: number, myRace: string, opponentRace: string, durationSec: number) {
  return {
    gameId: `pace-${key}`, date: `2026-11-${String(day).padStart(2, "0")}T12:00:00Z`, result: "Victory", durationSec,
    myRace, isLadderGame: true, gameVersion: "5.0.17.98000",
    myBuild: key === "eligible" ? "Fixture All-in" : null,
    opponent: { race: opponentRace, displayName: `Fixture ${key}` },
    macroBreakdown: { stats_events: ECONOMY },
  };
}

async function seedReports(page: Page) {
  const games = [
    game("eligible", 12, "Protoss", "Terran", 300),
    game("opponent", 11, "Terran", "Protoss", 300),
    game("unsupported", 10, "Terran", "Zerg", 300),
    game("short", 9, "Protoss", "Terran", 269),
    { ...game("incomplete", 8, "Protoss", "Terran", 270),
      macroBreakdown: { stats_events: ECONOMY.slice(0, -1) } },
    { ...game("unconfirmed", 7, "Protoss", "Terran", 300), isLadderGame: null },
  ];
  await page.evaluate(async ({ games, name, version, index }) => {
    const db = await new Promise<IDBDatabase>((resolve, reject) => {
      const open = indexedDB.open(name, version);
      open.onupgradeneeded = () => {
        open.result.createObjectStore("tryGames", { keyPath: "gameId" }).createIndex(index, "expiresAt");
        open.result.createObjectStore("ledger", { keyPath: "path" });
        open.result.createObjectStore("handles");
        open.result.createObjectStore("meta");
      };
      open.onsuccess = () => resolve(open.result);
      open.onerror = () => reject(open.error);
    });
    try {
      await new Promise<void>((resolve, reject) => {
        const write = db.transaction("tryGames", "readwrite");
        const now = Date.now();
        for (const game of games) {
          write.objectStore("tryGames").put({ gameId: game.gameId, date: game.date,
            storedAt: now, expiresAt: now + 600_000, json: JSON.stringify(game) });
        }
        write.oncomplete = () => resolve();
        write.onabort = () => reject(write.error);
      });
    } finally {
      db.close();
    }
  }, { games, name: INSTANT_DB_NAME, version: INSTANT_DB_VERSION, index: TRY_GAMES_EXPIRES_INDEX });
}

async function blockExternalTraffic(page: Page, origin: string) {
  const unexpected: string[] = [];
  await page.context().route("**/*", (route) => {
    const request = route.request();
    const url = new URL(request.url());
    if (url.hostname === "clerk.example.com" && request.method() === "GET") return route.abort();
    if (url.origin === origin && url.pathname === "/api/site/presence" && request.postData() === "{}") {
      return route.fulfill({ status: 204 });
    }
    if (url.origin === origin && request.method() === "GET" && !url.pathname.startsWith("/api/")) return route.continue();
    unexpected.push(`${request.method()} ${url.origin}${url.pathname}`);
    return route.abort();
  });
  return unexpected;
}

for (const theme of ["light", "dark"] as const) {
  test(`opening pace stays local and fits in ${theme}`, async ({ page }, info) => {
    const unexpected = await blockExternalTraffic(page, new URL(String(info.project.use.baseURL)).origin);
    await page.emulateMedia({ colorScheme: theme, reducedMotion: "reduce" });
    await page.goto("/try");
    await page.getByRole("button", { name: "Reject", exact: true }).click();
    await seedReports(page);
    await page.reload();
    await expect(page.getByRole("heading", { name: "Your instant report" })).toBeVisible();
    const pace = page.getByRole("region", { name: REGION });
    async function capturePace(state: string) {
      await pace.scrollIntoViewIfNeeded();
      await captureAccessibility(page, info, `try-pace-${theme}-${state}`);
    }
    await pace.scrollIntoViewIfNeeded();
    await expect(pace).toContainText("The replay labels an all-in.");
    if (SUPPORTED) {
      await expect(pace).toContainText("reference games");
      if (process.env.T2_SYNTHETIC_REFERENCE === "1") {
        await expect(pace).toContainText("20 s later");
        await expect(pace).toContainText("10 s later");
      }
    } else await expect(pace).toContainText("No reference yet for PvT in this patch era.");
    const issues = await new AxeBuilder({ page }).include("section[aria-label^='Pace gap']").withTags(["wcag2a", "wcag2aa", "wcag21aa"]).analyze();
    expect(issues.violations.filter(({ impact }) => impact === "serious" || impact === "critical")).toEqual([]);
    await capturePace(SUPPORTED ? "reference" : "unavailable");
    await expect(page.getByRole("list", { name: "Your games" })).toBeVisible();
    await page.getByRole("button", { name: /Fixture opponent/i }).click();
    if (REVERSE) {
      await expect(pace).toContainText("Terran opponents of a 5,300-MMR Protoss player.");
      await capturePace("opponent-reference");
    } else await expect(pace).toContainText("No reference yet for TvP in this patch era.");
    const unsupported = page.getByRole("button", { name: /Fixture unsupported/i });
    await unsupported.focus();
    await unsupported.press("Enter");
    await expect(pace).toContainText("No reference yet for TvZ");
    await capturePace("unsupported");
    await page.getByRole("button", { name: /Fixture short/i }).click();
    await expect(pace).toContainText("at least 4:30");
    await capturePace("short");
    if (SUPPORTED) {
      await page.getByRole("button", { name: /Fixture incomplete/i }).click();
      await expect(pace).toContainText("too little opening economy data");
      await capturePace("incomplete");
    }
    await page.getByRole("button", { name: /Fixture unconfirmed/i }).click();
    await expect(pace).toContainText("confirmed one-on-one ladder games");
    await capturePace("unconfirmed");
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(info.project.use.viewport?.width ?? 0);
    expect(unexpected).toEqual([]);
  });
}
