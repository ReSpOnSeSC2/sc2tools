import AxeBuilder from "@axe-core/playwright";
import { expect, test, type Page } from "@playwright/test";
import { INSTANT_DB_NAME, INSTANT_DB_VERSION, TRY_GAMES_EXPIRES_INDEX } from "../../lib/instant/idb";
import { captureAccessibility } from "./accessibility-check";

function fixtures(complete: boolean) {
  const races = complete ? [...Array<string>(10).fill("Terran"), ...Array<string>(8).fill("Zerg"), ...Array<string>(8).fill("Protoss")] : ["Terran", "Terran", "Zerg"];
  return races.map((race, index) => ({
    gameId: "private-source-" + index, date: new Date(Date.UTC(2026, 10, 1, 0, index)).toISOString(),
    result: index < 10 ? "Win" : "Loss", durationSec: 420, isLadderGame: true, myRace: "Protoss",
    myToonHandle: "1-S2-1-987654", myBuild: "Private Fixture Build", myMmr: 4321,
    opponent: { race, displayName: "Private Fixture Rival", toonHandle: "1-S2-1-2222" },
  }));
}

async function seedReport(page: Page, complete: boolean) {
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
        const store = write.objectStore("tryGames");
        store.clear();
        const now = Date.now();
        for (const game of games) store.put({ gameId: game.gameId, date: game.date, storedAt: now, expiresAt: now + 600_000, json: JSON.stringify(game) });
        write.oncomplete = () => resolve();
        write.onabort = () => reject(write.error);
      });
    } finally { db.close(); }
  }, { games: fixtures(complete), name: INSTANT_DB_NAME, version: INSTANT_DB_VERSION, index: TRY_GAMES_EXPIRES_INDEX });
}

async function blockExternalTraffic(page: Page, origin: string) {
  const unexpected: string[] = [];
  await page.context().route("**/*", (route) => {
    const request = route.request();
    const url = new URL(request.url());
    if (url.hostname === "clerk.example.com" && request.method() === "GET") return route.abort();
    if (url.origin === origin && url.pathname === "/api/site/presence" && request.postData() === "{}") return route.fulfill({ status: 204 });
    if (url.origin === origin && request.method() === "GET" && !url.pathname.startsWith("/api/")) return route.continue();
    unexpected.push(request.method() + " " + url.origin + url.pathname);
    return route.abort();
  });
  return unexpected;
}

for (const theme of ["light", "dark"] as const) {
  test("local Commander ID and share privacy in " + theme, async ({ page }, info) => {
    const unexpected = await blockExternalTraffic(page, new URL(String(info.project.use.baseURL)).origin);
    await page.addInitScript(() => Object.defineProperty(navigator, "clipboard", { value: {
      writeText: async (text: string) => localStorage.setItem("test-commander-link", text),
    } }));
    await page.emulateMedia({ colorScheme: theme, reducedMotion: "reduce" });
    await page.goto("/try");
    await page.getByRole("button", { name: "Reject", exact: true }).click();
    await seedReport(page, true);
    await page.reload();
    const commander = page.getByRole("region", { name: "Commander ID" });
    await expect(commander).toContainText("Clockwork Purist");
    await expect(commander).not.toContainText("Not enough games");
    await expect(commander).not.toContainText("Private Fixture");
    await commander.scrollIntoViewIfNeeded();
    const labelId = await commander.getAttribute("aria-labelledby");
    const issues = await new AxeBuilder({ page }).include('section[aria-labelledby="' + labelId + '"]').withTags(["wcag2a", "wcag2aa", "wcag21aa"]).analyze();
    expect(issues.violations.filter(row => row.impact === "serious" || row.impact === "critical")).toEqual([]);
    await captureAccessibility(page, info, "commander-" + theme + "-complete");
    const share = page.getByRole("button", { name: "Share report" });
    await share.focus();
    await share.press("Enter");
    const dialog = page.getByRole("dialog", { name: "Share your report" });
    const optIn = dialog.getByRole("checkbox", { name: "Commander ID" });
    await expect(optIn).not.toBeChecked();
    await optIn.check();
    await expect(dialog.getByRole("img")).toHaveAccessibleName(/Commander ID: .*Clockwork Purist/);
    await expect(dialog.getByRole("img")).not.toHaveAccessibleName(/Private Fixture|987654|4321|private-source/);
    await captureAccessibility(page, info, "commander-" + theme + "-share");
    await dialog.getByRole("button", { name: "Copy card link" }).click();
    await expect(dialog.getByRole("status")).toContainText("Card link copied.");
    await page.keyboard.press("Escape");
    await expect(share).toBeFocused();
    const url = new URL((await page.evaluate(() => localStorage.getItem("test-commander-link")))!);
    expect(url.search).toBe("");
    await page.goto(url.pathname + url.hash);
    const publicReport = page.getByRole("region", { name: "Shared replay report" });
    await expect(publicReport).toContainText(/Commander ID: .*Clockwork Purist/);
    await expect(publicReport).not.toContainText(/Private Fixture|987654|4321|private-source/);
    await page.goto("/try");
    await seedReport(page, false);
    await page.reload();
    await expect(commander.getByText("Not enough games")).toHaveCount(3);
    await expect(commander).toContainText("Incomplete");
    await commander.scrollIntoViewIfNeeded();
    await captureAccessibility(page, info, "commander-" + theme + "-incomplete");
    await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(info.project.use.viewport?.width ?? 0);
    expect(unexpected).toEqual([]);
  });
}
