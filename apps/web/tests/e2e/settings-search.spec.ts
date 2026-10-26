import { expect, test, type Page, type TestInfo } from "@playwright/test";
import { mkdir } from "node:fs/promises";
import path from "node:path";
import { checkAccessibility } from "./accessibility-check";
import { closeSettingsSearchFixtureServer, openSettingsSearchFixture } from "./settings-search-fixture.mjs";

type SearchWindow = typeof window & {
  sectionNavigate: (href: string) => void; sectionSetOwner: (owner: string) => void; sectionUnmount: () => void;
  sectionReleaseBoundary: (kind: "backups" | "client") => void; sectionBoundaryEvents: string[];
  sectionSocketEvents: Array<{ id: number; kind: string; event?: string }>;
  sectionSocketRejections: string[]; sectionNativeAttempts: string[];
  sectionScrolls: Array<{ id: string; label: string | null }>;
  searchDraft?: Element | null; searchManager?: Element | null;
};
type Evidence = Awaited<ReturnType<typeof openSettingsSearchFixture>>;
const widths = [320, 390, 768, 1280] as const;
const shots = path.resolve(process.env.SETTINGS_SEARCH_SHOTS_DIR ?? path.join("../../.cache", `settings-search-browser-${Date.now()}`));
const search = (page: Page) => page.getByRole("combobox", { name: "Find a setting", exact: true });
const results = (page: Page) => page.getByRole("listbox", { name: "Find a setting options", exact: true }).getByRole("option");
const nav = (page: Page) => page.getByRole("navigation", { name: "On this page", exact: true });
const confirm = (page: Page) => page.getByRole("dialog", { name: "Discard unsaved changes?", exact: true });
const profileIds = ["profile-details", "pulse-ids", "player-channels", "public-profile"];
const backupsIds = ["replay-archive", "snapshots", "repair-data", "hidden-games", "delete-history", "gdpr"];
const randomizerIds = ["build-randomizer", "catalog-builds", "custom-builds", "gateway-draw", "sound-effects", "randomizer-preview"];

async function choose(page: Page, query: string) {
  await search(page).fill(query); await search(page).press("ArrowDown"); await search(page).press("Enter");
}
async function targets(page: Page, ids: readonly string[]) {
  for (const id of ids) {
    const target = page.locator(`[id="${id}"]`); await expect(target).toHaveCount(1);
    expect(await target.evaluate(element => !element.closest("[hidden], [inert]")), `${id} is actual admitted DOM`).toBe(true);
  }
}
async function choices(page: Page, ids: readonly string[]) {
  await expect(nav(page)).toHaveCount(1);
  await expect.poll(() => nav(page).locator("select option").evaluateAll(options => options.map(option => (option as HTMLOptionElement).value))).toEqual(ids);
}
async function overflow(page: Page) {
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), "no body overflow").toBe(true);
}
async function capture(page: Page, info: TestInfo, theme: string, width: number, label: string) {
  await mkdir(shots, { recursive: true });
  await page.screenshot({ path: path.join(shots, `${info.project.name}-${theme}-${width}-${label}.png`) });
}
async function releaseBoundaries(page: Page) {
  await page.evaluate(() => { const state = window as Partial<SearchWindow>; state.sectionReleaseBoundary?.("backups"); state.sectionReleaseBoundary?.("client"); });
}
async function browserReceipt(page: Page) {
  return page.evaluate(() => {
    const state = window as Partial<SearchWindow>;
    return { socketEvents: state.sectionSocketEvents ?? [], socketRejections: state.sectionSocketRejections ?? [], nativeAttempts: state.sectionNativeAttempts ?? [],
      scrolls: state.sectionScrolls ?? [], boundaries: state.sectionBoundaryEvents ?? [] };
  });
}
async function clean(page: Page, evidence: Evidence, info: TestInfo) {
  await evidence.releaseAll(); await releaseBoundaries(page);
  await page.evaluate(() => (window as SearchWindow).sectionUnmount());
  await expect.poll(async () => {
    const browser = await browserReceipt(page);
    return browser.socketEvents.filter(row => row.kind === "create").every(created => browser.socketEvents.some(row => row.kind === "disconnect" && row.id === created.id));
  }).toBe(true);
  const browser = await browserReceipt(page);
  expect(evidence.errors).toEqual([]); expect(evidence.unexpectedRequests).toEqual([]);
  expect(evidence.rejectedWrites).toEqual([]); expect(evidence.externalAttempts).toEqual([]); expect(evidence.writes).toEqual([]);
  expect(browser.nativeAttempts).toEqual([]); expect(browser.socketRejections).toEqual([]);
  await info.attach("search-exact-local-transport", { contentType: "application/json", body: JSON.stringify({ ...evidence, ...browser, syntheticWrites: 0, realAccountProviderAgentWrites: 0 }) });
}
test.afterEach(async ({ page }, info) => {
  let browser: unknown = { rootAvailable: false, captureError: "Page closed" };
  try {
    for (const candidate of page.context().pages()) if (candidate !== page && !candidate.isClosed()) await candidate.close();
    if (!page.isClosed()) {
      await releaseBoundaries(page);
      browser = await page.evaluate(async () => {
        const state = window as Partial<SearchWindow>; const rootAvailable = typeof state.sectionUnmount === "function";
        state.sectionUnmount?.(); await new Promise<void>(resolve => setTimeout(resolve, 0));
        return { rootAvailable, captureError: null, socketEvents: state.sectionSocketEvents ?? [], socketRejections: state.sectionSocketRejections ?? [],
          nativeAttempts: state.sectionNativeAttempts ?? [], scrolls: state.sectionScrolls ?? [], boundaries: state.sectionBoundaryEvents ?? [] };
      });
    }
  } catch (error) { browser = { captureError: String(error) }; }
  finally {
    try { await info.attach("search-case-browser-ledgers", { contentType: "application/json", body: JSON.stringify(browser) }); }
    finally {
      const receipt = await closeSettingsSearchFixtureServer();
      await info.attach("search-case-http-cleanup", { contentType: "application/json", body: JSON.stringify(receipt) });
      expect(receipt.closed).toBe(true); expect(receipt.listening).toBe(false); expect(receipt.drainError).toBeNull();
    }
  }
});
test.afterAll(async ({ browserName }, info) => {
  const receipt = await closeSettingsSearchFixtureServer();
  await info.attach("search-final-listener-cleanup", { contentType: "application/json", body: JSON.stringify({ browserName, ...receipt }) });
  expect(receipt.listening).toBe(false);
});

for (const theme of ["light", "dark"] as const) {
  for (const width of widths) {
    test(`Settings search ${theme} ${width}: real targets, conditional rails and guarded fields`, async ({ page }, info) => {
      test.setTimeout(240_000); await page.setViewportSize({ width, height: 900 });
      const evidence = await openSettingsSearchFixture(page, theme);
      await targets(page, ["setup-health", "account-summary", "quick-links"]);
      await choices(page, ["setup-health", "account-summary", "quick-links"]);
      await expect.poll(() => evidence.reads.filter(row => ["/v1/me", "/v1/me/doctor", "/api/agent/version"].includes(row.path)).length).toBe(3);
      await expect(search(page)).toHaveCount(1); await expect(search(page)).toBeVisible();
      expect((await search(page).boundingBox())!.height).toBeGreaterThanOrEqual(44);
      await expect(page.locator("html")).toHaveAttribute("data-theme", theme);
      expect(await page.evaluate(() => getComputedStyle(document.body).fontFamily)).toContain("SettingsHanken");
      expect(evidence.buildId).toBeTruthy(); expect(evidence.cssNames.length).toBeGreaterThan(0);
      const reads = evidence.reads.slice();
      await page.getByRole("button", { name: "Reading focus" }).focus(); await page.keyboard.press("/"); await expect(search(page)).toBeFocused();
      for (const query of ["TTS volume", "Kick chatroom", "Pulse ID", "Delete account", "Overlay theme", "Reset overlay URLs"]) {
        await search(page).fill(query); await expect(results(page)).toHaveCount(1);
      }
      expect(evidence.reads).toEqual(reads); expect(evidence.writes).toEqual([]);
      const popup = await page.getByRole("listbox", { name: "Find a setting options", exact: true }).boundingBox();
      expect(popup).not.toBeNull(); expect(popup!.x).toBeGreaterThanOrEqual(0); expect(popup!.x + popup!.width).toBeLessThanOrEqual(width);
      expect(popup!.y).toBeGreaterThanOrEqual(0); expect(popup!.y + popup!.height).toBeLessThanOrEqual(900);
      await checkAccessibility(page, info, `/settings-search-account-${width}`, theme); await overflow(page);
      await capture(page, info, theme, width, "account-search");
      await search(page).press("Escape"); await expect(search(page)).toHaveAttribute("aria-expanded", "false");
      await choose(page, "Pulse ID"); await expect(page).toHaveURL(/\?tab=profile#pulse-ids$/);
      await targets(page, profileIds); await choices(page, profileIds);
      const name = page.getByRole("textbox", { name: "Display name", exact: true }); await name.fill("Unsaved synthetic draft");
      await page.evaluate(() => { (window as SearchWindow).searchDraft = document.querySelector('[id="profile-details"] input'); });
      const profileHref = page.url(); await choose(page, "Pulse ID"); await expect(confirm(page)).toHaveCount(0);
      await expect(name).toHaveValue("Unsaved synthetic draft");
      expect(await name.evaluate(element => element === (window as SearchWindow).searchDraft)).toBe(true);
      await checkAccessibility(page, info, `/settings-search-profile-${width}`, theme); await overflow(page);
      await capture(page, info, theme, width, "profile");
      await choose(page, "Delete account"); await expect(confirm(page)).toBeVisible();
      await confirm(page).getByRole("button", { name: "Stay on this tab" }).click();
      expect(page.url()).toBe(profileHref); await expect(name).toHaveValue("Unsaved synthetic draft");
      await choose(page, "Delete account"); await confirm(page).getByRole("button", { name: "Discard & switch" }).click();
      await expect(page).toHaveURL(/\?tab=backups#gdpr$/); await targets(page, backupsIds); await choices(page, backupsIds);
      expect(evidence.writes).toEqual([]); await checkAccessibility(page, info, `/settings-search-backups-${width}`, theme); await overflow(page);
      await choose(page, "Default tab"); await targets(page, ["app-preferences", "setup-privacy", "notifications"]);
      await choices(page, ["app-preferences", "setup-privacy", "notifications"]);
      await page.getByLabel("Default tab", { exact: true }).selectOption("macro");
      await page.getByRole("checkbox", { name: "New reviews", exact: true }).uncheck();
      await choose(page, "Notification preferences"); await expect(confirm(page)).toHaveCount(0);
      await choose(page, "Overlay theme"); await confirm(page).getByRole("button", { name: "Stay on this tab" }).click();
      await expect(page.getByLabel("Default tab", { exact: true })).toHaveValue("macro");
      await expect(page.getByRole("checkbox", { name: "New reviews", exact: true })).not.toBeChecked();
      await checkAccessibility(page, info, `/settings-search-preferences-${width}`, theme); await capture(page, info, theme, width, "preferences");
      await choose(page, "Overlay theme"); await confirm(page).getByRole("button", { name: "Discard & switch" }).click();
      const manager = page.getByRole("region", { name: "Shared streaming token controls", exact: true });
      await expect(manager).toHaveCount(1); await page.getByRole("combobox", { name: "URLs shown for" }).selectOption("owner-a-two");
      await page.evaluate(() => { (window as SearchWindow).searchManager = document.getElementById("tokens"); });
      const accent = page.getByLabel("Accent hex value", { exact: true }); await accent.fill("4CC3F1");
      await choose(page, "Overlay theme"); await expect(accent).toHaveValue("4CC3F1"); await expect(confirm(page)).toHaveCount(0);
      await checkAccessibility(page, info, `/settings-search-overlay-${width}`, theme); await overflow(page);
      await choose(page, "TTS volume"); await confirm(page).getByRole("button", { name: "Discard & switch" }).click();
      await expect(page).toHaveURL(/\?tab=chat#tts$/);
      expect(await manager.evaluate(element => element === (window as SearchWindow).searchManager)).toBe(true);
      await expect(page.getByRole("combobox", { name: "URLs shown for" })).toHaveValue("owner-a-two");
      expect(evidence.reads.filter(row => row.path === "/v1/overlay-tokens")).toHaveLength(1);
      await page.getByLabel(/Loyalty rank theme/).selectOption("zerg"); await page.getByLabel("Bot username", { exact: true }).fill("fixturebot");
      await choose(page, "Kick chatroom"); await expect(confirm(page)).toHaveCount(0); await expect(page).toHaveURL(/\?tab=chat#platforms$/);
      await choose(page, "Overlay theme"); await confirm(page).getByRole("button", { name: "Stay on this tab" }).click();
      await expect(page.getByLabel(/Loyalty rank theme/)).toHaveValue("zerg"); await expect(page.getByLabel("Bot username", { exact: true })).toHaveValue("fixturebot");
      await checkAccessibility(page, info, `/settings-search-chat-${width}`, theme); await capture(page, info, theme, width, "chat");
      await choose(page, "Build randomizer pool"); await confirm(page).getByRole("button", { name: "Discard & switch" }).click();
      await targets(page, randomizerIds); await choices(page, randomizerIds);
      await chooseSection(page, width, "gateway-draw", "Opening Gateway draw"); const gatewayHref = page.url();
      await page.getByRole("tablist", { name: "Matchups" }).getByRole("tab", { name: /\bTvP\b/ }).click();
      await expect(page.locator('[id="gateway-draw"]')).toHaveCount(0); await choices(page, randomizerIds.filter(id => id !== "gateway-draw"));
      expect(page.url()).toBe(gatewayHref);
      await checkAccessibility(page, info, `/settings-search-randomizer-${width}`, theme); await overflow(page);
      await capture(page, info, theme, width, "randomizer");
      await choose(page, "Replay import"); await targets(page, ["desktop-import", "import-jobs"]);
      await expect(page.locator('[id="browser-import"], [id="folder-sync"]')).toHaveCount(0); await expect(nav(page)).toHaveCount(0);
      await checkAccessibility(page, info, `/settings-search-import-off-${width}`, theme);
      await choose(page, "Voice readout"); await targets(page, ["voice-readout"]); await expect(nav(page)).toHaveCount(0);
      await checkAccessibility(page, info, `/settings-search-voice-${width}`, theme);
      await choose(page, "Build check-in prompts"); await targets(page, ["build-check-in"]); await expect(nav(page)).toHaveCount(0);
      await checkAccessibility(page, info, `/settings-search-checkin-${width}`, theme);
      await page.getByRole("tablist", { name: "Settings sections", exact: true }).nth(width < 1024 ? 0 : 1).getByRole("tab", { name: "Help", exact: true }).click();
      await expect(page.locator('[id="my-reports"]')).toHaveCount(1); await expect(page.locator('[id="getting-started"]')).toHaveCount(1);
      await expect(nav(page)).toHaveCount(0); await expect(search(page)).toHaveCount(1);
      await checkAccessibility(page, info, `/settings-search-help-${width}`, theme); await overflow(page);
      await clean(page, evidence, info);
    });
  }

  test(`Settings search ${theme} late profile: readiness after eight seconds preserves cancelled reveal`, async ({ page }, info) => {
    test.setTimeout(120_000); await page.setViewportSize({ width: 390, height: 900 });
    const evidence = await openSettingsSearchFixture(page, theme, { initialHref: "/settings?tab=profile#public-profile", holdProfileRead: true });
    await expect.poll(() => evidence.reads.filter(row => row.path === "/v1/me/profile").length).toBe(1);
    await page.getByRole("button", { name: "Reading focus" }).focus(); await page.keyboard.press("Tab");
    const before = await page.evaluate(() => ({ href: location.href, focus: document.activeElement?.id, y: scrollY, scrolls: (window as SearchWindow).sectionScrolls.filter(row => row.id === "public-profile") }));
    await page.waitForTimeout(8_050); evidence.releaseReads();
    await targets(page, profileIds); await choices(page, profileIds);
    const after = await page.evaluate(() => ({ href: location.href, focus: document.activeElement?.id, y: scrollY, scrolls: (window as SearchWindow).sectionScrolls.filter(row => row.id === "public-profile") }));
    expect(after).toEqual(before); await checkAccessibility(page, info, "/settings-search-late-profile", theme);
    await capture(page, info, theme, 390, "late-profile"); await clean(page, evidence, info);
  });

  test(`Settings search ${theme} owner A→B→A retires the old search input and held token read`, async ({ page }, info) => {
    test.setTimeout(120_000); await page.setViewportSize({ width: 390, height: 900 });
    const evidence = await openSettingsSearchFixture(page, theme, { holdTokenRead: true });
    await targets(page, ["setup-health", "account-summary", "quick-links"]); await choose(page, "Reset overlay URLs");
    await expect.poll(() => evidence.reads.filter(row => row.owner === "owner-a" && row.path === "/v1/overlay-tokens").length).toBe(1);
    const oldInput = await search(page).elementHandle();
    await page.evaluate(() => (window as SearchWindow).sectionSetOwner("owner-b"));
    await expect(page.getByRole("combobox", { name: "URLs shown for" })).toHaveValue("owner-b-one");
    await page.evaluate(() => (window as SearchWindow).sectionSetOwner("owner-a"));
    await expect(page.getByRole("combobox", { name: "URLs shown for" })).toHaveValue("owner-a-one");
    expect(await oldInput!.evaluate(element => element.isConnected)).toBe(false);
    await search(page).fill("Pulse ID"); const href = page.url(); evidence.releaseReads();
    await expect(page.getByRole("combobox", { name: "URLs shown for" })).toHaveValue("owner-a-one");
    await expect(search(page)).toHaveValue("Pulse ID"); expect(page.url()).toBe(href); await search(page).press("Escape");
    await checkAccessibility(page, info, "/settings-search-owner-aba", theme); await capture(page, info, theme, 390, "owner-aba");
    await clean(page, evidence, info);
  });

  test(`Settings search ${theme} late actual Backups and Hidden modules rearm only availability`, async ({ page }, info) => {
    test.setTimeout(150_000); await page.setViewportSize({ width: 390, height: 900 });
    const evidence = await openSettingsSearchFixture(page, theme, { initialHref: "/settings?tab=backups", holdBackupsModule: true, holdClientBoundaries: true });
    await expect(page.getByText("Loading Backups code…", { exact: true })).toBeVisible();
    await page.getByRole("button", { name: "Reading focus" }).focus();
    const before = await page.evaluate(() => ({ href: location.href, focus: document.activeElement?.id, y: scrollY, scrolls: (window as SearchWindow).sectionScrolls.slice() }));
    await page.waitForTimeout(8_050); await page.evaluate(() => (window as SearchWindow).sectionReleaseBoundary("backups"));
    await targets(page, backupsIds.filter(id => id !== "hidden-games")); await choices(page, backupsIds.filter(id => id !== "hidden-games"));
    await page.waitForTimeout(8_050); await page.evaluate(() => (window as SearchWindow).sectionReleaseBoundary("client"));
    await targets(page, backupsIds); await choices(page, backupsIds);
    expect(await page.evaluate(() => ({ href: location.href, focus: document.activeElement?.id, y: scrollY, scrolls: (window as SearchWindow).sectionScrolls.slice() }))).toEqual(before);
    await checkAccessibility(page, info, "/settings-search-late-backups", theme); await capture(page, info, theme, 390, "late-backups");
    await clean(page, evidence, info);
  });

  for (const variant of [{ mode: "all", admin: false, enabled: true }, { mode: "admins", admin: false, enabled: false }, { mode: "admins", admin: true, enabled: true }] as const) {
    test(`Settings search ${theme} Import ${variant.mode} admin=${variant.admin}: actual gated tools`, async ({ page }, info) => {
      test.setTimeout(120_000); await page.setViewportSize({ width: 390, height: 900 });
      const evidence = await openSettingsSearchFixture(page, theme, { initialHref: "/settings?tab=import", mode: variant.mode, admin: variant.admin, holdMeRead: true });
      await expect.poll(() => evidence.reads.filter(row => row.path === "/v1/me").length).toBe(1);
      await expect.poll(() => evidence.reads.filter(row => ["/v1/me", "/v1/import/status", "/v1/import/jobs"].includes(row.path)).length).toBe(3);
      if (variant.mode === "all") {
        await targets(page, ["browser-import", "folder-sync"]);
        await expect.poll(() => evidence.reads.filter(row => ["/v1/me/profile", "/v1/me/replay-archive-status"].includes(row.path)).length).toBe(2);
      }
      else await expect(page.locator('[id="browser-import"], [id="folder-sync"]')).toHaveCount(0);
      const reads = evidence.reads.slice(); await search(page).fill("Folder Sync"); await expect(results(page)).toHaveCount(1);
      expect(evidence.reads).toEqual(reads);
      await search(page).press("Escape"); evidence.releaseReads(); await targets(page, ["desktop-import", "import-jobs"]);
      if (variant.enabled) { await targets(page, ["browser-import", "folder-sync"]); await choices(page, ["desktop-import", "import-jobs", "browser-import", "folder-sync"]); }
      else { await expect(page.locator('[id="browser-import"], [id="folder-sync"]')).toHaveCount(0); await expect(nav(page)).toHaveCount(0); }
      await checkAccessibility(page, info, `/settings-search-import-${variant.mode}-${variant.admin}`, theme); await overflow(page);
      await capture(page, info, theme, 390, `import-${variant.mode}-${variant.admin}`); await clean(page, evidence, info);
    });
  }
}

async function chooseSection(page: Page, width: number, id: string, label: string) {
  if (width < 1024) await page.getByRole("combobox", { name: "On this page", exact: true }).selectOption(id);
  else await nav(page).getByRole("link", { name: label, exact: true }).click();
  await expect(page).toHaveURL(new RegExp(`#${id}$`));
}
