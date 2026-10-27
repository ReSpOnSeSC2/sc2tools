import { expect, test, type Page, type TestInfo } from "@playwright/test";
import { mkdir } from "node:fs/promises";
import path from "node:path";
import { checkAccessibility } from "./accessibility-check";
import { closeActivationChecklistFixtureServer, openActivationChecklistFixture } from "./activation-checklist-fixture.mjs";

type ActivationWindow = typeof window & {
  activationSetOwner: (owner: string | null) => void;
  activationShowGame: (gameId: string | null) => void;
  activationShowCard: (show: boolean) => void;
  activationNavigate: (href: string) => void;
  activationPushes: () => string[];
  activationRefresh: () => Promise<unknown>;
  activationSnapshot: (owner: string) => { firstGameViewed: boolean; levelUpDismissedAt: string | null } | null;
  activationHoldNextToken: () => void;
  activationTokenEvents: () => { owner: string; held: boolean; released: boolean }[];
  activationReleaseTokens: () => void;
  activationHoldNextBody: (path: string) => void;
  activationReleaseBodies: () => void;
  activationBodyEvents: { path: string; released: boolean }[];
  activationNativeAttempts: string[];
  activationUnmount: () => void;
};
type Evidence = Awaited<ReturnType<typeof openActivationChecklistFixture>>;
let current: Evidence | null = null;
const card = (page: Page) => page.getByTestId("level-up-checklist");
const markerPath = "/v1/me/activation/first-game";
const dismissPath = "/v1/me/preferences/onboarding";
const allDone = { identity: true, firstGameViewed: true, customBuild: true, checkIn: true, overlayLive: true, chatOn: true };

async function drainBrowser(page: Page) {
  await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
}

async function capture(page: Page, info: TestInfo, theme: string, label: string) {
  if (!process.env.ACTIVATION_SHOTS_DIR) return;
  const dir = path.resolve(process.env.ACTIVATION_SHOTS_DIR);
  await mkdir(dir, { recursive: true });
  await page.screenshot({ path: path.join(dir, `${info.project.name}-${theme}-${label}.png`), fullPage: true });
}

async function geometry(page: Page) {
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  const bounds = await card(page).boundingBox();
  expect(bounds).not.toBeNull(); expect(bounds!.x).toBeGreaterThanOrEqual(0);
  expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(page.viewportSize()!.width);
}

test.afterEach(async ({ page }, info) => {
  const evidence = current; current = null;
  if (!evidence && !page.isClosed()) await page.evaluate(() => {
    const host = window as ActivationWindow;
    host.activationUnmount?.(); host.activationReleaseTokens?.(); host.activationReleaseBodies?.();
  }).catch(() => {});
  const closure = evidence ? await evidence.close() : await closeActivationChecklistFixtureServer();
  const client = !page.isClosed() ? await page.evaluate(() => {
    const host = window as ActivationWindow;
    return { native: host.activationNativeAttempts ?? [], bodies: host.activationBodyEvents ?? [],
      tokens: host.activationTokenEvents?.() ?? [], pushes: host.activationPushes?.() ?? [] };
  }) : null;
  await info.attach("activation-transport-and-closure", { contentType: "application/json", body: JSON.stringify({
    closure, client, errors: evidence?.errors ?? [], unexpectedRequests: evidence?.unexpectedRequests ?? [],
    rejectedWrites: evidence?.rejectedWrites ?? [], externalAttempts: evidence?.externalAttempts ?? [],
    reads: evidence?.reads ?? [], writes: evidence?.writes ?? [], abortedResponses: evidence?.abortedResponses ?? [],
    cssNames: evidence?.cssNames ?? [], buildId: evidence?.buildId ?? null,
  }) });
  expect(closure.closed).toBe(true); expect(closure.listening).toBe(false); expect(closure.sockets).toBe(0);
  expect(client?.native ?? []).toEqual([]);
  if (evidence) {
    expect(evidence.errors).toEqual([]); expect(evidence.unexpectedRequests).toEqual([]);
    expect(evidence.rejectedWrites).toEqual([]); expect(evidence.externalAttempts).toEqual([]);
  }
});

for (const theme of ["light", "dark"] as const) {
  test(`Activation ${theme}: goals, Help, completion and confirmed dismissal`, async ({ page }, info) => {
    test.setTimeout(180_000);
    const evidence = current = await openActivationChecklistFixture(page, theme);
    const initialHref = page.url();
    await expect(page.locator("html")).toHaveAttribute("data-theme", theme);
    expect(await page.evaluate(() => getComputedStyle(document.body).fontFamily)).toContain("ActivationHanken");
    expect(evidence.buildId).toBeTruthy(); expect(evidence.cssNames.length).toBeGreaterThan(0);
    await expect(card(page).locator("ol > li")).toHaveCount(4);
    await expect(card(page).getByRole("progressbar", { name: "Suggested features tried" })).toHaveAttribute("aria-valuemax", "4");
    await expect(card(page).getByRole("link", { name: "Open Builds", exact: true })).toHaveAttribute("href", "/builds");
    await expect(card(page).getByRole("link", { name: "Open Overlay", exact: true })).toHaveCount(0);
    await geometry(page); await checkAccessibility(page, info, "/activation-improve", theme);

    const help = card(page).getByRole("link", { name: "Your first week", exact: true });
    await expect(help).toHaveAttribute("aria-haspopup", "dialog");
    await help.focus(); await page.keyboard.press("Enter");
    const dialog = page.getByRole("dialog", { name: "Your first week", exact: true });
    await expect(dialog).toBeVisible(); await expect(dialog.getByRole("link", { name: "Open full article", exact: true })).toHaveAttribute("href", "/help/your-first-week");
    await checkAccessibility(page, info, "/activation-help", theme); await capture(page, info, theme, "help");
    await page.keyboard.press("Escape"); await expect(dialog).toHaveCount(0); await expect(help).toBeFocused();

    evidence.setActivation("owner-a", { goals: ["stream"] }); await page.evaluate(() => (window as ActivationWindow).activationRefresh());
    await expect(card(page).locator("ol > li")).toHaveCount(4);
    await expect(card(page).getByRole("link", { name: "Open Builds", exact: true })).toHaveCount(0);
    await expect(card(page).getByRole("link", { name: "Open Chat & alerts", exact: true })).toHaveAttribute("href", "/settings?tab=chat#platforms");
    evidence.setActivation("owner-a", { goals: [] }); await page.evaluate(() => (window as ActivationWindow).activationRefresh());
    await expect(card(page).locator("ol > li")).toHaveCount(6);
    await expect(card(page).getByRole("progressbar")).toHaveAttribute("aria-valuemax", "6");
    expect(page.url()).toBe(initialHref); expect(await page.evaluate(() => (window as ActivationWindow).activationPushes())).toEqual([]);
    await geometry(page); await checkAccessibility(page, info, "/activation-all", theme); await capture(page, info, theme, "all-features");

    await card(page).getByRole("link", { name: "Open Profile", exact: true }).click();
    await expect(page.getByRole("region", { name: "Selected destination" })).toHaveText(/\/settings\?tab=profile/);
    expect(await page.evaluate(() => (window as ActivationWindow).activationPushes())).toEqual(["/settings?tab=profile"]);
    await page.evaluate(() => (window as ActivationWindow).activationNavigate("/app"));
    await expect(card(page).locator("ol > li")).toHaveCount(6);
    evidence.setActivation("owner-a", allDone); await page.evaluate(() => (window as ActivationWindow).activationRefresh());
    await expect(card(page).getByRole("link", { name: "see What's new", exact: true })).toHaveAttribute("href", "/changelog");
    await expect(card(page).locator("ol > li")).toHaveCount(0);
    const notifications = page.getByRole("region", { name: "Notifications", exact: true });
    await expect(notifications.getByRole("status")).toHaveCount(1);
    await expect(notifications.getByRole("status")).toContainText("You're all set");
    await notifications.getByRole("button", { name: "Dismiss notification", exact: true }).click();
    await checkAccessibility(page, info, "/activation-complete", theme);
    await page.evaluate(() => (window as ActivationWindow).activationShowCard(false));
    await expect(card(page)).toHaveCount(0); await page.evaluate(() => (window as ActivationWindow).activationShowCard(true));
    await expect(card(page).getByRole("link", { name: "see What's new", exact: true })).toBeVisible();
    await drainBrowser(page); await expect(notifications.getByRole("status")).toHaveCount(0);

    evidence.setActivation("owner-a", { customBuild: false }); await page.evaluate(() => (window as ActivationWindow).activationRefresh());
    await expect(card(page).getByRole("button", { name: "Dismiss suggestions", exact: true })).toBeVisible();
    evidence.failNextDismissal(); await card(page).getByRole("button", { name: "Dismiss suggestions", exact: true }).click();
    await expect(card(page).getByRole("button", { name: "Retry", exact: true })).toBeVisible();
    expect(evidence.writes).toHaveLength(1); expect(evidence.writes[0].status).toBe(503);
    await checkAccessibility(page, info, "/activation-dismiss-error", theme);
    await page.evaluate(pathname => (window as ActivationWindow).activationHoldNextBody(pathname), dismissPath);
    const retry = card(page).getByRole("button", { name: "Retry", exact: true });
    const retryElement = await retry.elementHandle(); await retry.click();
    const retrying = card(page).getByRole("button", { name: "Retrying…", exact: true });
    await expect(retrying).toBeFocused(); await expect(retrying).toHaveAttribute("aria-busy", "true");
    expect(await retryElement!.evaluate(element => element.isConnected)).toBe(true);
    const pending = card(page).getByRole("button", { name: "Dismissing…", exact: true });
    await expect(pending).toHaveAttribute("aria-busy", "true"); await expect(pending).toHaveAttribute("aria-disabled", "true");
    await expect.poll(() => evidence.writes.length).toBe(2);
    await expect.poll(() => page.evaluate(() => (window as ActivationWindow).activationBodyEvents.filter(row => row.path === "/v1/me/preferences/onboarding" && !row.released).length)).toBe(1);
    await retrying.press("Enter"); await drainBrowser(page); expect(evidence.writes).toHaveLength(2);
    await expect(card(page)).toBeVisible(); await page.evaluate(() => (window as ActivationWindow).activationReleaseBodies());
    await expect(card(page)).toHaveCount(0);
    expect(evidence.writes.map(row => ({ owner: row.owner, method: row.method, path: row.path, status: row.status }))).toEqual([
      { owner: "owner-a", method: "PUT", path: dismissPath, status: 503 },
      { owner: "owner-a", method: "PUT", path: dismissPath, status: 200 },
    ]);
    for (const write of evidence.writes) expect(Object.keys(write.body)).toEqual(["levelUpDismissedAt"]);
    expect(page.url()).toBe(initialHref); expect(await page.evaluate(() => (window as ActivationWindow).activationPushes())).toEqual(["/settings?tab=profile"]);
  });

  test(`Activation ${theme}: owner ABA retires held marker JWT, body and dismissal`, async ({ page }, info) => {
    test.setTimeout(150_000);
    const evidence = current = await openActivationChecklistFixture(page, theme);
    evidence.holdNextGame("game-one"); await page.evaluate(() => (window as ActivationWindow).activationShowGame("game-one"));
    await expect.poll(() => evidence.reads.filter(row => row.owner === "owner-a" && row.path === "/v1/games/game-one").length).toBe(1);
    await page.evaluate(() => (window as ActivationWindow).activationHoldNextToken()); evidence.releaseReads();
    await expect.poll(() => page.evaluate(() => (window as ActivationWindow).activationTokenEvents().filter(row => row.owner === "owner-a" && row.held && !row.released).length)).toBe(1);
    expect(evidence.writes).toEqual([]);
    await page.evaluate(() => { const host = window as ActivationWindow; host.activationShowGame(null); host.activationSetOwner("owner-b"); });
    await expect(card(page).getByRole("link", { name: "Open Chat & alerts", exact: true })).toBeVisible();
    await page.evaluate(() => (window as ActivationWindow).activationSetOwner("owner-a"));
    await expect(card(page).getByRole("link", { name: "Open Builds", exact: true })).toBeVisible();
    await page.evaluate(() => (window as ActivationWindow).activationReleaseTokens()); await drainBrowser(page);
    expect(evidence.writes).toEqual([]);
    expect(await page.evaluate(() => (window as ActivationWindow).activationSnapshot("owner-a")?.firstGameViewed)).toBe(false);

    evidence.holdNextGame("game-two"); await page.evaluate(() => (window as ActivationWindow).activationShowGame("game-two"));
    await expect.poll(() => evidence.reads.filter(row => row.owner === "owner-a" && row.path === "/v1/games/game-two").length).toBe(1);
    await page.evaluate(pathname => (window as ActivationWindow).activationHoldNextBody(pathname), markerPath); evidence.releaseReads();
    await expect.poll(() => evidence.writes.filter(row => row.path === markerPath).length).toBe(1);
    await expect.poll(() => page.evaluate(() => (window as ActivationWindow).activationBodyEvents.filter(row => row.path === "/v1/me/activation/first-game" && !row.released).length)).toBe(1);
    await expect(page.getByRole("status", { name: "View marker state", exact: true })).toHaveText("pending");
    await page.evaluate(() => { const host = window as ActivationWindow; host.activationShowGame(null); host.activationSetOwner("owner-b"); });
    await expect(card(page).getByRole("link", { name: "Open Chat & alerts", exact: true })).toBeVisible();
    evidence.holdNextActivation("owner-a"); await page.evaluate(() => (window as ActivationWindow).activationSetOwner("owner-a"));
    await expect(card(page).getByRole("link", { name: "Open Builds", exact: true })).toBeVisible();
    await page.evaluate(() => (window as ActivationWindow).activationReleaseBodies()); await drainBrowser(page);
    expect(await page.evaluate(() => (window as ActivationWindow).activationSnapshot("owner-a")?.firstGameViewed)).toBe(false);
    expect(evidence.writes.filter(row => row.path === markerPath)).toEqual([
      { owner: "owner-a", method: "PUT", path: markerPath, body: { gameId: "game-two" }, status: 200 },
    ]);

    await page.evaluate(pathname => (window as ActivationWindow).activationHoldNextBody(pathname), dismissPath);
    await card(page).getByRole("button", { name: "Dismiss suggestions", exact: true }).click();
    await expect.poll(() => evidence.writes.filter(row => row.path === dismissPath).length).toBe(1);
    await expect.poll(() => page.evaluate(() => (window as ActivationWindow).activationBodyEvents.filter(row => row.path === "/v1/me/preferences/onboarding" && !row.released).length)).toBe(1);
    await page.evaluate(() => (window as ActivationWindow).activationSetOwner("owner-b"));
    await expect(card(page).getByRole("link", { name: "Open Chat & alerts", exact: true })).toBeVisible();
    await page.evaluate(() => (window as ActivationWindow).activationReleaseBodies()); await drainBrowser(page);
    await expect(card(page).getByRole("button", { name: "Dismiss suggestions", exact: true })).toBeVisible();
    expect(await page.evaluate(() => (window as ActivationWindow).activationSnapshot("owner-b")?.levelUpDismissedAt)).toBeNull();
    await expect(page.getByRole("region", { name: "Notifications", exact: true }).getByRole("status")).toHaveCount(0);
    expect(evidence.writes).toHaveLength(2); expect(evidence.writes.every(row => row.owner === "owner-a")).toBe(true);
    await geometry(page); await checkAccessibility(page, info, "/activation-owner-aba", theme); await capture(page, info, theme, "owner-aba");
    expect(await page.evaluate(() => (window as ActivationWindow).activationPushes())).toEqual([]);
  });
}
