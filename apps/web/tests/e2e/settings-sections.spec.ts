import { expect, test, type Page, type TestInfo } from "@playwright/test";
import { mkdir } from "node:fs/promises";
import path from "node:path";
import { checkAccessibility } from "./accessibility-check";
import { closeSettingsSectionsFixtureServer, openSettingsSectionsFixture } from "./settings-sections-fixture.mjs";

type SectionWindow = typeof window & {
  sectionNavigate: (href: string) => void;
  sectionSetOwner: (owner: string) => void;
  sectionUnmount: () => void;
  sectionPushes: () => string[];
  sectionSocketEvents: Array<{ id: number; kind: string; event?: string }>;
  sectionSocketRejections: string[];
  sectionNativeAttempts: string[];
  sectionScrolls: Array<{ id: string; label: string | null }>;
  sectionManager?: Element | null;
};
type Evidence = Awaited<ReturnType<typeof openSettingsSectionsFixture>>;
const widths = [320, 390, 768, 1280] as const;
const overlaySections = ["setup", "widgets", "scenes", "build-profile", "ghost-coach", "theme", "tokens"];
const chatSections = ["platforms", "appearance", "alerts", "tts", "translation", "commands", "twitch-automation", "dock", "bot", "tokens"];
const shots = path.resolve(process.env.SETTINGS_SECTIONS_SHOTS_DIR ?? path.join("../../.cache", `settings-sections-browser-${Date.now()}`));
const tabs = (page: Page) => page.getByRole("tablist", { name: "Settings sections", exact: true });
const manager = (page: Page) => page.getByRole("region", { name: "Shared streaming token controls", exact: true });
const onThisPage = (page: Page) => page.getByRole("navigation", { name: "On this page", exact: true });

async function selectSection(page: Page, width: number, id: string, label: string) {
  if (width < 1024) await page.getByRole("combobox", { name: "On this page", exact: true }).selectOption(id);
  else await onThisPage(page).getByRole("link", { name: label, exact: true }).click();
  await expect(page).toHaveURL(new RegExp(`#${id}$`));
}

async function expectActive(page: Page, width: number, id: string) {
  if (width < 1024) await expect(page.getByRole("combobox", { name: "On this page", exact: true })).toHaveValue(id);
  else await expect(onThisPage(page).locator(`[href$="#${id}"]`)).toHaveAttribute("aria-current", /^(?:location|true|page)$/);
}

async function uniqueTargets(page: Page, ids: readonly string[]) {
  for (const id of ids) {
    await expect(page.locator(`[id="${id}"]`)).toHaveCount(1);
    expect(await page.locator(`[id="${id}"]`).evaluate(element => !element.closest("[hidden], [inert]")), `${id} is an actual readable target`).toBe(true);
  }
}

async function capture(page: Page, info: TestInfo, theme: string, width: number, label: string) {
  await mkdir(shots, { recursive: true });
  await page.screenshot({ path: path.join(shots, `${info.project.name}-${theme}-${width}-${label}.png`) });
}

async function clean(page: Page, evidence: Evidence, info: TestInfo) {
  await evidence.releaseAll();
  await page.evaluate(() => (window as SectionWindow).sectionUnmount());
  await expect.poll(() => page.evaluate(() => {
    const events = (window as SectionWindow).sectionSocketEvents;
    return events.filter(row => row.kind === "create").every(created => events.some(row => row.kind === "disconnect" && row.id === created.id));
  })).toBe(true);
  const browser = await page.evaluate(() => ({ socketEvents: (window as SectionWindow).sectionSocketEvents, socketRejections: (window as SectionWindow).sectionSocketRejections, nativeAttempts: (window as SectionWindow).sectionNativeAttempts, scrolls: (window as SectionWindow).sectionScrolls }));
  expect(evidence.errors).toEqual([]); expect(evidence.unexpectedRequests).toEqual([]);
  expect(evidence.rejectedWrites).toEqual([]); expect(evidence.externalAttempts).toEqual([]);
  expect(evidence.writes).toEqual([]); expect(browser.nativeAttempts).toEqual([]); expect(browser.socketRejections).toEqual([]);
  await info.attach("sections-exact-local-transport", { contentType: "application/json", body: JSON.stringify({ ...evidence, releaseAll: undefined, releaseTokenReads: undefined, holdNextTokenRead: undefined, ...browser, syntheticWrites: 0, realAccountProviderAgentWrites: 0 }) });
}

test.afterAll(async ({ browserName }, info) => {
  const receipt = await closeSettingsSectionsFixtureServer();
  expect(receipt.closed).toBe(true); expect(receipt.listening).toBe(false);
  await info.attach("sections-loopback-cleanup", { contentType: "application/json", body: JSON.stringify({ browserName, ...receipt }) });
});

// Also runs after an assertion failure: retire real hook lifetimes, release
// held synthetic responses and close the owned ephemeral listener each time.
test.afterEach(async ({ page }, info) => {
  let browser: {
    rootAvailable: boolean; captureError: string | null;
    socketEvents: SectionWindow["sectionSocketEvents"]; socketRejections: string[];
    nativeAttempts: string[]; scrolls: SectionWindow["sectionScrolls"];
  } = { rootAvailable: false, captureError: null, socketEvents: [], socketRejections: [], nativeAttempts: [], scrolls: [] };
  try {
    for (const candidate of page.context().pages()) if (candidate !== page && !candidate.isClosed()) await candidate.close();
    if (!page.isClosed()) browser = await page.evaluate(async () => {
      const state = window as Partial<SectionWindow>, stop = state.sectionUnmount;
      const rootAvailable = typeof stop === "function";
      if (typeof stop === "function") stop();
      // Real realtime ref-count cleanup releases its last socket next task.
      await new Promise<void>(resolve => setTimeout(resolve, 0));
      return { rootAvailable, captureError: null,
        socketEvents: Array.isArray(state.sectionSocketEvents) ? state.sectionSocketEvents : [],
        socketRejections: Array.isArray(state.sectionSocketRejections) ? state.sectionSocketRejections : [],
        nativeAttempts: Array.isArray(state.sectionNativeAttempts) ? state.sectionNativeAttempts : [],
        scrolls: Array.isArray(state.sectionScrolls) ? state.sectionScrolls : [],
      };
    });
    else browser.captureError = "Page closed before browser-ledger capture";
  } catch (error) {
    browser.captureError = String(error);
  } finally {
    try {
      await info.attach("sections-case-browser-ledgers", { contentType: "application/json", body: JSON.stringify(browser) });
    } finally {
      const receipt = await closeSettingsSectionsFixtureServer();
      await info.attach("sections-case-listener-cleanup", { contentType: "application/json", body: JSON.stringify(receipt) });
      expect(receipt.closed).toBe(true); expect(receipt.listening).toBe(false); expect(receipt.drainError).toBeNull();
    }
  }
  expect(browser.captureError).toBeNull();
});

for (const theme of ["light", "dark"] as const) {
  for (const width of widths) {
    test(`Settings sections ${theme} ${width}: actual panels, scrollspy, drafts and one token lifetime`, async ({ page }, info) => {
      test.setTimeout(180_000);
      await page.setViewportSize({ width, height: 900 });
      const evidence = await openSettingsSectionsFixture(page, theme);
      await expect(page.getByRole("heading", { name: "account synthetic panel", exact: true })).toBeVisible();
      expect(evidence.reads).toEqual([]); expect(evidence.writes).toEqual([]);
      await expect(page.locator("html")).toHaveAttribute("data-theme", theme);
      await expect(page.locator("html")).toHaveAttribute("data-theme-mode", theme);
      expect(await page.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue("--bg").trim().replace(/\s+/g, " "))).toBe(theme === "light" ? "244 246 250" : "6 9 14");
      expect(await page.evaluate(() => getComputedStyle(document.body).fontFamily)).toContain("SettingsHanken");
      expect(evidence.buildId).toBeTruthy(); expect(evidence.cssNames.length).toBeGreaterThan(0);

      await page.evaluate(() => (window as SectionWindow).sectionNavigate("/settings?tab=overlay&section=look&ref=sections#theme"));
      await expect(page).toHaveURL(/\/settings\?tab=overlay&ref=sections#theme$/);
      await expect(manager(page)).toHaveCount(1);
      await expect(page.getByLabel("Accent hex value", { exact: true })).toBeVisible();
      await uniqueTargets(page, overlaySections);
      await expect(page.locator("#theme")).toHaveAttribute("data-section-flash", /.+/);
      await expect(page.locator("#ghost")).toHaveCount(0);
      expect(evidence.reads.filter(row => row.path === "/v1/overlay-tokens")).toEqual([{ owner: "owner-a", path: "/v1/overlay-tokens" }]);
      await expect(onThisPage(page)).toHaveCount(1);
      if (width < 1024) {
        const select = page.getByRole("combobox", { name: "On this page", exact: true });
        await expect(select).toBeVisible(); expect((await select.boundingBox())!.height).toBeGreaterThanOrEqual(44);
        expect(await select.locator("option").evaluateAll(options => options.map(option => (option as HTMLOptionElement).value))).toEqual(overlaySections);
      } else {
        for (const link of await onThisPage(page).getByRole("link").all()) expect((await link.boundingBox())!.height).toBeGreaterThanOrEqual(44);
      }
      await checkAccessibility(page, info, `/settings-sections-overlay-${width}`, theme);
      await capture(page, info, theme, width, "overlay-theme");

      if (theme === "light" && width === 1280) {
        await page.locator("#theme").scrollIntoViewIfNeeded();
        expect(await page.locator("#widgets").evaluate(element => element.getBoundingClientRect().bottom <= 0)).toBe(true);
        const presenceBefore = evidence.reads.filter(row => row.path.endsWith("/presence")).length;
        // One deliberate cadence proof: exceed the existing 15s interval with
        // the actual visibility hook. Other matrix cases do not incur this wait.
        await page.waitForTimeout(15_100);
        const presenceAfter = evidence.reads.filter(row => row.path.endsWith("/presence")).length;
        expect(presenceAfter).toBe(presenceBefore);
        await info.attach("sections-health-visibility-cadence", { contentType: "application/json", body: JSON.stringify({ waitMs: 15_100, presenceBefore, presenceAfter, theme, width }) });
      }

      await manager(page).getByRole("combobox", { name: "URLs shown for", exact: true }).selectOption("owner-a-two");
      await expect(manager(page).getByRole("combobox", { name: "URLs shown for", exact: true })).toHaveValue("owner-a-two");
      await expect(page.getByLabel("Accent hex value", { exact: true })).toBeVisible();
      expect(evidence.reads.filter(row => row.path === "/v1/overlay-tokens")).toHaveLength(1);

      // Keep one real profile draft while explicit same-tab navigation changes
      // the reading position. The draft and its DOM owner must stay mounted.
      await page.getByLabel("Accent hex value", { exact: true }).fill("#336699");
      await expect(manager(page).getByRole("combobox", { name: "URLs shown for", exact: true })).toBeDisabled();
      await page.evaluate(() => { (window as SectionWindow).sectionManager = document.querySelector("#tokens select"); });
      await selectSection(page, width, "widgets", "Widgets");
      await expect(page.getByRole("dialog", { name: "Discard unsaved changes?", exact: true })).toHaveCount(0);
      await expect(page.getByLabel("Accent hex value", { exact: true })).toHaveValue("#336699");

      // An actual passive document scroll may update IO's highlight only.
      // No click, route, synthetic IO callback or fabricated target is used.
      await page.evaluate(() => {
        document.getElementById("fixture-focus")!.focus({ preventScroll: true });
        (window as SectionWindow).sectionScrolls.length = 0;
        const target = document.getElementById("scenes")!;
        window.scrollTo(0, target.getBoundingClientRect().top + window.scrollY - 125);
      });
      await expectActive(page, width, "scenes");
      const passive = await page.evaluate(() => ({ href: location.href, y: scrollY, focus: document.activeElement?.id, calls: (window as SectionWindow).sectionScrolls.slice() }));
      await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
      expect(await page.evaluate(() => ({ href: location.href, y: scrollY, focus: document.activeElement?.id, calls: (window as SectionWindow).sectionScrolls.slice() }))).toEqual(passive);
      expect(passive.href).toMatch(/#widgets$/); expect(passive.focus).toBe("fixture-focus"); expect(passive.calls).toEqual([]);
      const repeatedHref = page.url();
      await page.evaluate(() => { (window as SectionWindow).sectionScrolls.length = 0; });
      await selectSection(page, width, "widgets", "Widgets");
      await expect.poll(() => page.evaluate(() => (window as SectionWindow).sectionScrolls.filter(row => row.id === "widgets").length)).toBe(1);
      await expect(page.locator("#widgets")).toHaveAttribute("data-section-flash", /.+/);
      await expect(page).toHaveURL(repeatedHref);
      await selectSection(page, width, "tokens", "Tokens");
      await expect(page.locator("#tokens")).toHaveAttribute("data-section-flash", /.+/);
      expect(await page.locator("#tokens").evaluate(element => element.getBoundingClientRect().top < innerHeight)).toBe(true);
      await expect(page.getByLabel("Accent hex value", { exact: true })).toHaveValue("#336699");
      await page.getByRole("button", { name: "Discard", exact: true }).click();
      await expect(manager(page).getByRole("combobox", { name: "URLs shown for", exact: true })).toBeEnabled();

      await tabs(page).getByRole("tab", { name: "Chat & alerts", exact: true }).click();
      await expect(page.getByRole("button", { name: "Save chat settings", exact: true })).toBeVisible();
      await uniqueTargets(page, chatSections);
      expect(await page.evaluate(() => (window as SectionWindow).sectionManager === document.querySelector("#tokens select"))).toBe(true);
      await expect(manager(page).getByRole("combobox", { name: "URLs shown for", exact: true })).toHaveValue("owner-a-two");
      expect(evidence.reads.filter(row => row.path === "/v1/overlay-tokens")).toHaveLength(1);
      await page.getByLabel(/Loyalty rank theme/).selectOption("zerg");
      await page.getByLabel("Bot username", { exact: true }).fill("retained-two-form-draft");
      await selectSection(page, width, "dock", "Stream Dock");
      await expect(page.getByRole("dialog", { name: "Discard unsaved changes?", exact: true })).toHaveCount(0);
      await expect(page.getByLabel("Bot username", { exact: true })).toHaveValue("retained-two-form-draft");
      await expect(page.getByLabel(/Loyalty rank theme/)).toHaveValue("zerg");
      await expect(manager(page).getByRole("combobox", { name: "URLs shown for", exact: true })).toBeDisabled();
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
      await checkAccessibility(page, info, `/settings-sections-chat-${width}`, theme);
      await capture(page, info, theme, width, "chat-dock");

      if (width === 1280) {
        const devices = page.getByRole("navigation", { name: "Settings navigation", exact: true }).getByRole("link", { name: "Devices", exact: true });
        const before = page.url(), pushes = await page.evaluate(() => (window as SectionWindow).sectionPushes());
        const opened = page.context().waitForEvent("page"); await devices.click({ modifiers: ["Control"] });
        const popup = await opened; await expect(popup.getByRole("heading", { name: "Devices destination", exact: true })).toBeVisible(); await popup.close(); await page.bringToFront();
        await expect(page).toHaveURL(before); expect(await page.evaluate(() => (window as SectionWindow).sectionPushes())).toEqual(pushes);
        await expect(page.getByRole("dialog", { name: "Discard unsaved changes?", exact: true })).toHaveCount(0);
        expect(evidence.popupLoads).toEqual(["GET /devices"]);
      }

      const admitted = page.url();
      await page.evaluate(() => (window as SectionWindow).sectionNavigate("/settings?tab=overlay&section=look&ref=guard#ghost"));
      const guard = page.getByRole("dialog", { name: "Discard unsaved changes?", exact: true });
      await expect(guard).toBeVisible(); await guard.getByRole("button", { name: "Stay on this tab", exact: true }).click();
      await expect(page).toHaveURL(admitted); await expect(page.getByLabel("Bot username", { exact: true })).toHaveValue("retained-two-form-draft");
      await tabs(page).getByRole("tab", { name: "Overlay", exact: true }).click();
      await guard.getByRole("button", { name: "Discard & switch", exact: true }).click();
      await page.evaluate(() => (window as SectionWindow).sectionNavigate("/settings?tab=overlay&section=look&ref=alias#ghost"));
      await expect(page).toHaveURL(/\?tab=overlay&ref=alias#ghost-coach$/);
      await expect(page.locator("#ghost-coach")).toHaveAttribute("data-section-flash", /.+/);
      expect(evidence.reads.filter(row => row.path === "/v1/overlay-tokens")).toHaveLength(1);
      if (theme === "light" && width === 1280) {
        evidence.holdNextTokenRead();
        await page.evaluate(() => (window as SectionWindow).sectionSetOwner("owner-b"));
        await expect.poll(() => evidence.reads.filter(row => row.path === "/v1/overlay-tokens").length).toBe(2);
        await expect(onThisPage(page)).toHaveCount(0);
        await expect(page.locator("#ghost-coach")).toHaveCount(0);
        await page.evaluate(() => (window as SectionWindow).sectionSetOwner("owner-a"));
        await expect(manager(page).getByRole("combobox", { name: "URLs shown for", exact: true })).toHaveValue("owner-a-one");
        evidence.releaseTokenReads(); await evidence.releaseAll();
        await expect(manager(page).getByRole("combobox", { name: "URLs shown for", exact: true })).toHaveValue("owner-a-one");
        await expect(onThisPage(page)).toHaveCount(1); await uniqueTargets(page, overlaySections);
        expect(evidence.reads.filter(row => row.path === "/v1/overlay-tokens")).toEqual([
          { owner: "owner-a", path: "/v1/overlay-tokens" }, { owner: "owner-b", path: "/v1/overlay-tokens" }, { owner: "owner-a", path: "/v1/overlay-tokens" },
        ]);
      }
      expect(evidence.writes).toEqual([]);
      await clean(page, evidence, info);
    });
  }

  for (const width of [320, 1280]) {
    test(`Settings sections ${theme} ${width}: real delayed owner reveals once and user input cancels a later reveal`, async ({ page }, info) => {
      test.setTimeout(120_000); await page.setViewportSize({ width, height: 900 });
      const evidence = await openSettingsSectionsFixture(page, theme, { initialHref: "/settings?tab=overlay&section=look#theme", holdTokenRead: true });
      await expect.poll(() => evidence.reads.length).toBe(1);
      expect(evidence.reads).toEqual([{ owner: "owner-a", path: "/v1/overlay-tokens" }]);
      await expect(page.locator("#theme")).toHaveCount(0); expect(evidence.writes).toEqual([]);
      evidence.releaseTokenReads();
      await expect(page.locator("#theme")).toHaveAttribute("data-section-flash", /.+/);
      expect(await page.evaluate(() => (window as SectionWindow).sectionScrolls.filter(row => row.id === "theme").length)).toBe(1);
      await uniqueTargets(page, overlaySections);

      await tabs(page).getByRole("tab", { name: "Account", exact: true }).click();
      await expect(page.getByRole("heading", { name: "account synthetic panel", exact: true })).toBeVisible();
      evidence.holdNextTokenRead();
      await page.evaluate(() => { (window as SectionWindow).sectionScrolls.length = 0; (window as SectionWindow).sectionNavigate("/settings?tab=overlay#theme"); });
      await expect.poll(() => evidence.reads.filter(row => row.path === "/v1/overlay-tokens").length).toBe(2);
      await expect(page.locator("#theme")).toHaveCount(0);
      await page.keyboard.press("Tab");
      evidence.releaseTokenReads();
      await expect(page.getByLabel("Accent hex value", { exact: true })).toBeVisible();
      await expect(page.locator("#theme")).not.toHaveAttribute("data-section-flash", /.+/);
      expect(await page.evaluate(() => (window as SectionWindow).sectionScrolls.filter(row => row.id === "theme"))).toEqual([]);
      await expect(onThisPage(page)).toHaveCount(1); await uniqueTargets(page, overlaySections);
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
      await checkAccessibility(page, info, `/settings-sections-delayed-${width}`, theme);
      await capture(page, info, theme, width, "delayed-cancelled");
      await clean(page, evidence, info);
    });
  }
}
