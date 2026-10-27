import AxeBuilder from "@axe-core/playwright";
import { chromium, expect, test, type BrowserContext, type Page, type TestInfo } from "@playwright/test";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import path from "node:path";
import { checkAccessibility } from "../e2e/accessibility-check";
import { openSessionsBrowserFixture as openFixture } from "./sessions-browser-fixture.mjs";

const GAP = "A session ends after N minutes without a game";
const PROFILE = "/v1/me/profile", POLICY = "/v1/me/session-policy";
const themes = ["light", "dark"] as const;
type Fixture = Awaited<ReturnType<typeof openFixture>>;
async function openSessionsBrowserFixture(page: Page, options: Parameters<typeof openFixture>[1], info: TestInfo) {
  try { return await openFixture(page, options); }
  catch (error) {
    if (error && typeof error === "object" && "sessionsWireAndClosure" in error) await info.attach("sessions-setup-wire-and-closure", { contentType: "application/json", body: JSON.stringify(error.sessionsWireAndClosure) });
    throw error;
  }
}
type BrowserBoundary = {
  observations: Array<{ owner: string; epoch: number; gap: number | null; loading: boolean; error: string | null }>;
  faults: unknown[]; data: (owner: string, endpoint: string) => unknown;
  cacheSnapshot: () => Array<{ key: string; data: unknown }>;
  cacheDedupingInterval: () => number | null;
  armCacheFault: (owner: string) => void; setWidget: (value: string) => void;
};
declare global {
  interface Window {
    sessionsBrowser: BrowserBoundary;
    sessionsAuth: { snapshot: () => { owner: string; held: null | { owner: string; token: string } }; arm: () => void; release: () => void; events: unknown[] };
  }
}

async function settle(page: Page, fixture: Fixture) {
  await page.waitForLoadState("networkidle");
  await expect.poll(() => fixture.state.requests.every(row => row.complete || row.held)).toBe(true);
}
async function baseline(page: Page, fixture: Fixture, value = "") {
  await expect(page.getByRole("spinbutton", { name: GAP, exact: true })).toHaveValue(value);
  await expect(page.getByTestId("policy-observation")).toContainText("minutes /");
  await settle(page, fixture);
}
async function owner(page: Page, fixture: Fixture, next: "synthetic-a" | "synthetic-b", value: string) {
  await page.getByRole("button", { name: `Owner ${next}`, exact: true }).click();
  await expect(page.getByRole("status", { name: "Fixture owner" })).toHaveText(next);
  await baseline(page, fixture, value);
}
async function dismissToasts(page: Page) {
  const buttons = page.getByRole("button", { name: "Dismiss notification", exact: true });
  for (let count = await buttons.count(); count > 0; count--) await buttons.first().click();
}
async function save(page: Page, value: string) {
  await page.getByRole("spinbutton", { name: GAP, exact: true }).fill(value);
  await page.getByRole("button", { name: "Save changes", exact: true }).click();
  await expect(page.getByText("Profile saved", { exact: true })).toBeVisible();
  await expect(page.getByRole("region", { name: "Unsaved changes", exact: true })).toHaveCount(0);
}
async function keyboardSave(page: Page) {
  const button = page.getByRole("button", { name: "Save changes", exact: true });
  for (let count = 0; count < 60 && !await button.evaluate(element => element === document.activeElement); count++) await page.keyboard.press("Tab");
  await expect(button).toBeFocused();
  const focus = await button.evaluate(element => {
    const rect = element.getBoundingClientRect(), css = getComputedStyle(element);
    return { width: rect.width, height: rect.height, outline: css.outlineStyle, outlineWidth: css.outlineWidth, shadow: css.boxShadow };
  });
  expect(focus.width).toBeGreaterThanOrEqual(44); expect(focus.height).toBeGreaterThanOrEqual(44);
  expect(focus.outline !== "none" && focus.outlineWidth !== "0px" || focus.shadow !== "none").toBe(true);
  await page.keyboard.press("Enter");
}
async function nativeDevicePixelCapture(page: Page, info: TestInfo, label: string) {
  const session = await page.context().newCDPSession(page);
  try {
    const layout = await session.send("Page.getLayoutMetrics");
    const device = layout.contentSize, css = layout.cssContentSize;
    const zoom = await page.evaluate(() => ({ dpr: devicePixelRatio, innerWidth, outerWidth,
      visualScale: visualViewport?.scale, rootZoom: getComputedStyle(document.documentElement).zoom }));
    await info.attach(`${label}-capture-layout`, { contentType: "application/json", body: JSON.stringify({
      purpose: "Native200 screenshot clip in legacy device pixels; no emulation or zoom change", layout, zoom }) });
    expect(zoom).toMatchObject({ dpr: 2, innerWidth: 632, outerWidth: 1280, visualScale: 1, rootZoom: "1" });
    expect(device.width / css.width).toBeCloseTo(2, 2);
    expect(device.height / css.height).toBeCloseTo(2, 2);
    const capture = await session.send("Page.captureScreenshot", { format: "png", fromSurface: true,
      captureBeyondViewport: true, clip: { x: device.x, y: device.y, width: device.width, height: device.height, scale: 1 } });
    const png = Buffer.from(capture.data, "base64");
    // Attach the raw pixels and exact dimensions even if the capability check fails.
    await info.attach(`${label}-screen`, { body: png, contentType: "image/png" });
    expect(png.subarray(0, 8).toString("hex")).toBe("89504e470d0a1a0a");
    const pixels = { width: png.readUInt32BE(16), height: png.readUInt32BE(20) };
    await info.attach(`${label}-capture-pixels`, { contentType: "application/json", body: JSON.stringify({
      pixels, clip: { ...device, scale: 1 }, css, zoom, requiresVisualReview: true }) });
    expect(Math.abs(pixels.width - device.width)).toBeLessThanOrEqual(1);
    expect(Math.abs(pixels.height - device.height)).toBeLessThanOrEqual(1);
  } finally { await session.detach(); }
}
async function aa(page: Page, info: TestInfo, theme: string, label: string) {
  if (process.env.A11Y_COLLECT_ONLY) throw new Error("Focused Sessions proof forbids collect-only accessibility mode");
  await page.evaluate(() => document.fonts.ready);
  const result = await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag21aa"]).analyze();
  await info.attach(`${label}-full-AA`, { contentType: "application/json", body: JSON.stringify({ violations: result.violations, incomplete: result.incomplete, passes: result.passes.map(row => row.id) }) });
  const route = `/sessions-${label}`;
  await checkAccessibility(page, info, route, theme);
  expect(result.violations, `${route}: all AA impacts remain a gate`).toEqual([]);
  expect(await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)).toBeLessThanOrEqual(1);
  const canvas = page.getByTestId("widget-canvas");
  if (await canvas.count() && await canvas.locator(".widget-shell").count()) {
    const bounds = await canvas.evaluate(element => {
      const outer = element.getBoundingClientRect(), panel = element.querySelector(".widget-shell")!.getBoundingClientRect();
      return { left: panel.left - outer.left, right: outer.right - panel.right, top: panel.top - outer.top, bottom: outer.bottom - panel.bottom };
    });
    expect(Math.min(bounds.left, bounds.right, bounds.top, bounds.bottom)).toBeGreaterThanOrEqual(-1);
  }
  if (label.includes("desktop1280-native200-632CSS")) await nativeDevicePixelCapture(page, info, label);
  else await info.attach(`${label}-screen`, { body: await page.screenshot({ fullPage: true }), contentType: "image/png" });
}
async function identity(page: Page, fixture: Fixture, info: TestInfo, theme: string) {
  await info.attach("sessions-source-build-import-assets", { contentType: "application/json", body: JSON.stringify(fixture.identity) });
  expect(await page.locator("html").getAttribute("class")).toContain(theme);
  const fonts = await page.evaluate(() => ({
    body: getComputedStyle(document.body).fontFamily,
    loaded: [...document.fonts].filter(face => face.status === "loaded").map(face => face.family),
    background: getComputedStyle(document.body).backgroundColor,
  }));
  expect(fonts.body).toContain("SessionsHanken");
  expect(fonts.loaded).toContain("SessionsHanken"); expect(fonts.loaded).toContain("SessionsBricolage");
  expect(fonts.background).toBe(theme === "light" ? "rgb(244, 246, 250)" : "rgb(6, 9, 14)");
}
async function close(fixture: Fixture | undefined, info: TestInfo, label = "sessions-wire-and-closure") {
  if (!fixture) return;
  const receipt = await fixture.close();
  await info.attach(label, { contentType: "application/json", body: JSON.stringify(receipt) });
  expect(receipt.listening).toBe(false); expect(receipt.openSockets).toBe(0); expect(receipt.heldResponses).toBe(0);
  expect(receipt.errors).toEqual([]); expect(receipt.unexpected).toEqual([]); expect(receipt.external).toEqual([]);
  const expected503 = receipt.requests.filter(row => row.status === 503);
  const unexplainedConsole = receipt.console.filter(row => !(row.type === "error" && /Failed to load resource.*503/.test(row.text)
    && expected503.some(request => row.location.url === fixture.state.origin + request.path + request.query)));
  expect(unexplainedConsole).toEqual([]);
  const unexplainedFailure = receipt.failures.filter(row => !(row.closing && /ERR_ABORTED|ERR_FAILED/.test(row.error))
    && !(row.method === "PUT" && new URL(row.url).pathname === PROFILE && /ERR_ABORTED|ERR_FAILED/.test(row.error)
      && receipt.requests.some(request => request.path === PROFILE && request.method === "PUT" && request.held && request.aborted)));
  expect(unexplainedFailure).toEqual([]);
  expect(receipt.requests.some(row => row.method === "OPTIONS")).toBe(false); // same-origin suite makes no CORS claim
}

type NativeZoomMetrics = { outerWidth: number; outerHeight: number; innerWidth: number; devicePixelRatio: number; visualViewportScale: number | null; rootZoom: string };
type NativeZoomProbe = { status: string; supported: boolean; clean: boolean; listenerClosed: boolean; openSockets: number;
  pins: Array<{ file: string; sha256: string }>; profiles: Array<{ label: string; metrics: NativeZoomMetrics }> };
async function nativeWidgetProfile(info: TestInfo) {
  const probePath = process.env.SESSIONS_NATIVE_ZOOM_PROBE;
  const probeSha256 = process.env.SESSIONS_NATIVE_ZOOM_PROBE_SHA256;
  if (!probePath || !path.isAbsolute(probePath) || !probeSha256 || !/^[a-f0-9]{64}$/.test(probeSha256)) throw new Error("Supply the root-reviewed native zoom probe path and SHA256");
  const probeBytes = await readFile(probePath);
  expect(createHash("sha256").update(probeBytes).digest("hex")).toBe(probeSha256);
  const probe = JSON.parse(probeBytes.toString("utf8")) as NativeZoomProbe;
  await info.attach("desktop1280-native200-supported-probe", { contentType: "application/json", body: probeBytes });
  expect(probe).toMatchObject({ status: "NATIVE_ZOOM_SUPPORTED", supported: true, clean: true, listenerClosed: true, openSockets: 0 });
  const binary = probe.pins.find(row => row.file.endsWith("/chrome.exe"));
  const executablePath = process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE;
  if (!binary || !executablePath || path.resolve(executablePath).toLowerCase() !== path.resolve(binary.file).toLowerCase()) throw new Error("Native phase requires the positively probed full Chrome binary");
  expect(createHash("sha256").update(await readFile(executablePath)).digest("hex")).toBe(binary.sha256);
  // Test output only: every case creates a new profile; an existing directory fails.
  await mkdir(info.outputDir, { recursive: true });
  const profileDir = info.outputPath("desktop1280-native200-new-profile");
  await mkdir(profileDir); await mkdir(path.join(profileDir, "Default"));
  await writeFile(path.join(profileDir, "Default", "Preferences"), JSON.stringify({ partition: { default_zoom_level: { x: Math.log(2) / Math.log(1.2) } } }) + "\n", { flag: "wx" });
  return { profileDir, executablePath, probe };
}

for (const theme of themes) test.describe(theme, () => {
  test("S01 explicit45 and Auto commit through real Profile controls", async ({ page }, info) => {
    let fixture: Fixture | undefined;
    try {
      fixture = await openSessionsBrowserFixture(page, { theme, surface: "profile" }, info);
      await baseline(page, fixture); await identity(page, fixture, info, theme); await aa(page, info, theme, "profile-baseline");
      const reads = fixture.api("GET", PROFILE).length + fixture.api("GET", POLICY).length;
      const gap = page.getByRole("spinbutton", { name: GAP, exact: true }); await gap.fill("45"); await gap.focus();
      await aa(page, info, theme, "profile-dirty45"); await keyboardSave(page);
      await expect(page.getByText("Profile saved", { exact: true })).toBeVisible();
      await expect(page.getByText("Currently 45 minutes from your preference.", { exact: true })).toBeVisible();
      expect(fixture.state.commits).toHaveLength(1); expect(fixture.state.commits[0]).toMatchObject({ owner: "synthetic-a", body: { sessionGapMinutes: 45 } });
      expect(fixture.api("GET", PROFILE).length + fixture.api("GET", POLICY).length).toBe(reads);
      await aa(page, info, theme, "profile-confirmed45"); await dismissToasts(page);
      await save(page, "");
      expect(fixture.state.commits[1].body).toHaveProperty("sessionGapMinutes", null);
      await expect(page.getByText("Currently 90 minutes on Auto.", { exact: true })).toBeVisible();
      await aa(page, info, theme, "profile-confirmedAuto90"); await dismissToasts(page);
      await owner(page, fixture, "synthetic-b", "45"); await save(page, "");
      expect(fixture.state.commits[2]).toMatchObject({ owner: "synthetic-b", body: { sessionGapMinutes: null }, policy: { gapMinutes: 240, source: "auto-overlay" } });
      await expect(page.getByText("Currently 240 minutes on Auto.", { exact: true })).toBeVisible();
      await aa(page, info, theme, "profile-confirmedAuto240");
      await page.reload(); await baseline(page, fixture); await owner(page, fixture, "synthetic-b", "");
      await expect(page.getByText("Currently 240 minutes on Auto.", { exact: true })).toBeVisible();
      expect(fixture.api("PUT", PROFILE)).toHaveLength(3); expect(fixture.state.commits).toHaveLength(3);
    } finally { await close(fixture, info); }
  });

  test("S02 invalid drafts and failed-save Retry remain honest", async ({ page }, info) => {
    let fixture: Fixture | undefined;
    try {
      fixture = await openSessionsBrowserFixture(page, { theme, surface: "profile" }, info); await baseline(page, fixture); await identity(page, fixture, info, theme);
      for (const value of ["15.5", "14", "481"]) {
        await page.getByRole("spinbutton", { name: GAP, exact: true }).fill(value);
        await page.getByRole("button", { name: "Save changes", exact: true }).click();
        expect(fixture.api("PUT", PROFILE)).toHaveLength(0); expect(fixture.state.commits).toHaveLength(0);
        if (value === "15.5") await aa(page, info, theme, "profile-invalidDraft");
        await dismissToasts(page);
      }
      fixture.failNextPut(); await page.getByRole("spinbutton", { name: GAP, exact: true }).fill("45");
      await page.getByRole("button", { name: "Save changes", exact: true }).click();
      await expect(page.getByText("Couldn't save profile", { exact: true })).toBeVisible();
      await expect(page.getByRole("spinbutton", { name: GAP, exact: true })).toHaveValue("45");
      await expect(page.getByRole("button", { name: "Save changes", exact: true })).toBeEnabled();
      expect(fixture.api("PUT", PROFILE)).toHaveLength(1); expect(fixture.state.commits).toHaveLength(0);
      await expect(page.getByText("Profile saved", { exact: true })).toHaveCount(0);
      await aa(page, info, theme, "profile-failed503WithRetry"); await dismissToasts(page);
      await page.getByRole("button", { name: "Save changes", exact: true }).click();
      await expect(page.getByText("Profile saved", { exact: true })).toBeVisible();
      expect(fixture.api("PUT", PROFILE)).toHaveLength(2); expect(fixture.state.commits).toHaveLength(1);
      await expect(page.getByRole("region", { name: "Unsaved changes", exact: true })).toHaveCount(0);
      await aa(page, info, theme, "profile-confirmedRetry");
    } finally { await close(fixture, info); }
  });

  test("S03 confirmed PUT survives advisory policy-cache fault", async ({ page }, info) => {
    let fixture: Fixture | undefined;
    try {
      fixture = await openSessionsBrowserFixture(page, { theme, surface: "profile" }, info); await baseline(page, fixture); await identity(page, fixture, info, theme);
      await owner(page, fixture, "synthetic-b", "45"); await owner(page, fixture, "synthetic-a", "");
      const other = await page.evaluate(() => window.sessionsBrowser.cacheSnapshot().filter(row => row.key.includes("synthetic-b")));
      const reads = fixture.api("GET", PROFILE).length + fixture.api("GET", POLICY).length;
      fixture.holdNextPut(); await page.getByRole("spinbutton", { name: GAP, exact: true }).fill("45");
      await page.getByRole("button", { name: "Save changes", exact: true }).click();
      await expect.poll(() => fixture!.state.holds.size).toBe(1); expect(fixture.state.commits).toHaveLength(1);
      await page.evaluate(() => window.sessionsBrowser.armCacheFault("synthetic-a")); fixture.releaseBodies();
      await expect(page.getByText("Profile saved", { exact: true })).toBeVisible();
      expect(await page.evaluate(() => window.sessionsBrowser.faults.length)).toBe(1);
      await expect(page.getByText("Couldn't save profile", { exact: true })).toHaveCount(0);
      await expect(page.getByRole("region", { name: "Unsaved changes", exact: true })).toHaveCount(0);
      await expect(page.getByText("Currently 45 minutes from your preference.", { exact: true })).toBeVisible();
      expect(fixture.api("GET", PROFILE).length + fixture.api("GET", POLICY).length).toBe(reads);
      expect(await page.evaluate(() => window.sessionsBrowser.cacheSnapshot().filter(row => row.key.includes("synthetic-b")))).toEqual(other);
      await aa(page, info, theme, "profile-confirmedAckDespiteAdvisoryFault");
      await page.getByRole("button", { name: "Remount policy reader", exact: true }).click();
      await expect(page.getByTestId("policy-observation")).toHaveText("45 minutes / preference");
      await aa(page, info, theme, "profile-currentPolicyAfterNewRead");
    } finally { await close(fixture, info); }
  });

  test("S04 held owner work and drafts retire across A to B to A", async ({ page }, info) => {
    let fixture: Fixture | undefined;
    try {
      fixture = await openSessionsBrowserFixture(page, { theme, surface: "profile" }, info); await baseline(page, fixture); await identity(page, fixture, info, theme);
      await page.evaluate(() => window.sessionsAuth.arm());
      await page.getByRole("spinbutton", { name: GAP, exact: true }).fill("45"); await page.getByRole("button", { name: "Save changes", exact: true }).click();
      await expect.poll(() => page.evaluate(() => window.sessionsAuth.snapshot().held?.owner)).toBe("synthetic-a");
      await owner(page, fixture, "synthetic-b", "45"); await aa(page, info, theme, "profile-freshOwnerB");
      await owner(page, fixture, "synthetic-a", ""); await page.evaluate(() => window.sessionsAuth.release());
      await settle(page, fixture); expect(fixture.api("PUT", PROFILE)).toHaveLength(0);
      await expect(page.getByText("Profile saved", { exact: true })).toHaveCount(0);
      await page.getByRole("spinbutton", { name: GAP, exact: true }).fill("47");
      await owner(page, fixture, "synthetic-b", "45"); await owner(page, fixture, "synthetic-a", "");
      fixture.holdNextPut(); await page.getByRole("spinbutton", { name: GAP, exact: true }).fill("45");
      await page.getByRole("button", { name: "Save changes", exact: true }).click();
      await expect.poll(() => fixture!.state.holds.size).toBe(1); fixture.seed("synthetic-a", 60);
      await owner(page, fixture, "synthetic-b", "45");
      // Profile uses the real SWR default. Let its completed GET's dedupe
      // window expire before deliberately requiring a distinct new A baseline.
      const dedupe = await page.evaluate(() => window.sessionsBrowser.cacheDedupingInterval());
      expect(typeof dedupe).toBe("number"); expect(dedupe).toBeGreaterThanOrEqual(0); expect(dedupe).toBeLessThanOrEqual(5000);
      const lastRead = Math.max(...fixture.api("GET", PROFILE).filter(row => row.owner === "synthetic-a").map(row => row.finishedAt ?? row.at));
      await expect.poll(() => Date.now() - lastRead).toBeGreaterThan((dedupe ?? 0) + 50);
      await owner(page, fixture, "synthetic-a", "60");
      await page.getByRole("spinbutton", { name: GAP, exact: true }).fill("75"); fixture.releaseBodies();
      await settle(page, fixture);
      await expect(page.getByRole("spinbutton", { name: GAP, exact: true })).toHaveValue("75");
      await expect(page.getByRole("region", { name: "Unsaved changes", exact: true })).toBeVisible();
      await expect(page.getByText("Profile saved", { exact: true })).toHaveCount(0);
      await expect(page.getByText("Couldn't save profile", { exact: true })).toHaveCount(0);
      expect(await page.evaluate(() => window.sessionsBrowser.data("synthetic-a", "/v1/me/profile"))).toMatchObject({ sessionGapMinutes: 60 });
      expect(fixture.api("PUT", PROFILE)).toHaveLength(1);
      expect(fixture.api("PUT", PROFILE)[0]).toMatchObject({ held: true, aborted: true, releaseAttempted: true });
      await info.attach("auth-owner-and-observation-timeline", { contentType: "application/json", body: JSON.stringify(await page.evaluate(() => ({ auth: window.sessionsAuth.events, policy: window.sessionsBrowser.observations }))) });
      await aa(page, info, theme, "profile-newOwnerADraftAfterLateRelease");
    } finally { await close(fixture, info); }
  });

  test("S05 unavailable policy and real Retry admit only a current read", async ({ page }, info) => {
    let fixture: Fixture | undefined;
    try {
      fixture = await openSessionsBrowserFixture(page, { theme, surface: "policy", initialPolicy: "fail" }, info);
      await identity(page, fixture, info, theme);
      const retry = page.getByRole("region", { name: "Direct session quiz" }).getByRole("button", { name: "Retry session settings", exact: true });
      await expect(retry).toBeVisible(); await expect(page.getByTestId("policy-observation")).toHaveText("Current policy unavailable");
      expect(fixture.api("GET", PROFILE)).toHaveLength(0); expect(fixture.api("GET", POLICY)).toHaveLength(1);
      await aa(page, info, theme, "policy-unavailable503");
      fixture.autoOverlay("synthetic-a", true); await retry.click();
      await expect(page.getByTestId("policy-observation")).toHaveText("240 minutes / auto-overlay");
      await settle(page, fixture); expect(fixture.api("GET", POLICY)).toHaveLength(2);
      await page.getByRole("button", { name: "Hide policy reader", exact: true }).click();
      fixture.seed("synthetic-a", 45); fixture.policy("hold", { gapMinutes: 45, source: "preference", storedGapMinutes: 45 });
      const start = await page.evaluate(() => window.sessionsBrowser.observations.length);
      await page.getByRole("button", { name: "Remount policy reader", exact: true }).click();
      await expect.poll(() => fixture!.state.holds.size).toBe(1);
      const waiting = await page.evaluate(index => window.sessionsBrowser.observations.slice(index), start);
      expect(waiting.length).toBeGreaterThan(0); expect(waiting[0].gap).toBeNull(); expect(waiting.every(row => row.gap === null)).toBe(true);
      await aa(page, info, theme, "policy-warmCurrentReadPending"); fixture.releaseBodies();
      await expect(page.getByTestId("policy-observation")).toHaveText("45 minutes / preference");
      await aa(page, info, theme, "policy-currentPolicyAdmitted");
      await page.getByRole("button", { name: "Hide policy reader", exact: true }).click(); fixture.policy("malformed");
      await page.getByRole("button", { name: "Remount policy reader", exact: true }).click();
      await expect(retry).toBeVisible(); await expect(page.getByTestId("policy-observation")).toHaveText("Current policy unavailable");
      await aa(page, info, theme, "policy-malformedPolicyUnavailable"); await retry.click();
      await expect(page.getByTestId("policy-observation")).toHaveText("45 minutes / preference");
      expect(fixture.api("GET", POLICY)).toHaveLength(5); expect(fixture.api("GET", PROFILE)).toHaveLength(0);
      expect(fixture.state.commits).toHaveLength(0);
    } finally { await close(fixture, info); }
  });

  test("S06 real widget gap and legacy fallback remain readable", async ({ page }, info) => {
    let fixture: Fixture | undefined, nativeContext: BrowserContext | undefined;
    let nativeClosed = false;
    let phase = "normal-widget";
    try {
      await page.clock.setFixedTime(new Date("2026-10-27T12:30:00Z"));
      fixture = await openSessionsBrowserFixture(page, { theme, surface: "widget" }, info); await identity(page, fixture, info, theme);
      const canvas = page.getByTestId("widget-canvas");
      await expect(canvas.getByText("gap >45m", { exact: true })).toBeVisible(); await expect(canvas.getByText(/30m/)).toHaveCount(0);
      await aa(page, info, theme, "widget-zeroClockGap45");
      await page.evaluate(() => window.sessionsBrowser.setWidget("auto90")); await expect(canvas.getByText("gap >90m", { exact: true })).toBeVisible();
      await aa(page, info, theme, "widget-auto90");
      await page.evaluate(() => window.sessionsBrowser.setWidget("active240")); await expect(canvas.getByText("30m · gap >240m", { exact: true })).toBeVisible();
      const shell = await canvas.locator(".widget-shell__panel").evaluate(element => ({ color: getComputedStyle(element).color, background: getComputedStyle(element).backgroundImage }));
      expect(shell.color).toBe("rgb(230, 232, 238)"); expect(shell.background).toContain("linear-gradient");
      await aa(page, info, theme, "widget-activeGap240");
      await page.evaluate(() => window.sessionsBrowser.setWidget("legacy")); await expect(canvas.getByText(/gap >/)).toHaveCount(0);
      await expect(canvas).toContainText("MMR"); await expect(canvas.getByText("—", { exact: true })).toHaveCount(2);
      await aa(page, info, theme, "widget-legacyFallback");
      await page.evaluate(() => window.sessionsBrowser.setWidget("none")); await expect(canvas.locator(".widget-shell")).toHaveCount(0);
      expect(fixture.state.requests.some(row => row.path.startsWith("/v1/"))).toBe(false);
      const normalFixture = fixture; fixture = undefined;
      await close(normalFixture, info, "normal-widget-wire-and-closure");

      // Fresh client state: desktop physical1280x900 at native200%, verified632 CSS px.
      // This is not phone195 CSS px and does not preserve the previous root/cache/owner.
      phase = "desktop1280-native200-632CSS";
      const native = await nativeWidgetProfile(info);
      nativeContext = await chromium.launchPersistentContext(native.profileDir, { executablePath: native.executablePath,
        headless: true, viewport: null, serviceWorkers: "block", timeout: 20_000,
        args: ["--window-size=1280,900", "--proxy-server=direct://", "--proxy-bypass-list=*"] });
      nativeContext.once("close", () => { nativeClosed = true; });
      expect(nativeContext.pages()).toHaveLength(1);
      const nativePage = nativeContext.pages()[0];
      await nativePage.clock.setFixedTime(new Date("2026-10-27T12:30:00Z"));
      fixture = await openSessionsBrowserFixture(nativePage, { theme, surface: "widget" }, info); await identity(nativePage, fixture, info, theme);
      const metrics: NativeZoomMetrics = await nativePage.evaluate(() => ({ outerWidth, outerHeight, innerWidth, devicePixelRatio,
        visualViewportScale: visualViewport?.scale ?? null, rootZoom: getComputedStyle(document.documentElement).zoom }));
      await info.attach(phase + "-metrics", { contentType: "application/json", body: JSON.stringify({ phase,
        normalProject: info.project.name, freshProfile: native.profileDir, freshClientState: true, metrics }) });
      const expected = native.probe.profiles.find(row => row.label === "200")?.metrics;
      expect(expected).toBeDefined();
      expect(metrics).toMatchObject({ outerWidth: 1280, outerHeight: 900, innerWidth: 632, devicePixelRatio: 2, visualViewportScale: 1, rootZoom: "1" });
      expect(metrics).toEqual(expected && { outerWidth: expected.outerWidth, outerHeight: expected.outerHeight,
        innerWidth: expected.innerWidth, devicePixelRatio: expected.devicePixelRatio, visualViewportScale: expected.visualViewportScale, rootZoom: expected.rootZoom });
      const nativeCanvas = nativePage.getByTestId("widget-canvas");
      for (const [value, text] of [["cloud45", "gap >45m"], ["auto90", "gap >90m"], ["active240", "30m · gap >240m"], ["legacy", "MMR"]]) {
        await nativePage.evaluate(next => window.sessionsBrowser.setWidget(next), value);
        await expect(nativeCanvas).toContainText(text);
        if (value === "legacy") { await expect(nativeCanvas.getByText(/gap >/)).toHaveCount(0); await expect(nativeCanvas.getByText("—", { exact: true })).toHaveCount(2); }
        if (value === "cloud45") await expect(nativeCanvas.getByText(/30m/)).toHaveCount(0);
        await aa(nativePage, info, theme, `widget-${value}-desktop1280-native200-632CSS`);
      }
      await nativePage.evaluate(() => window.sessionsBrowser.setWidget("none")); await expect(nativeCanvas.locator(".widget-shell")).toHaveCount(0);
      expect(fixture.state.requests.some(row => row.path.startsWith("/v1/"))).toBe(false);
    } finally {
      try { await close(fixture, info, phase + "-wire-and-closure"); }
      finally {
        if (nativeContext) {
          const nativeBrowser = nativeContext.browser();
          try { await nativeContext.close(); }
          finally {
            const browserConnected = nativeBrowser ? nativeBrowser.isConnected() : null;
            await info.attach("desktop1280-native200-context-closure", { contentType: "application/json", body: JSON.stringify({ contextClosed: nativeClosed, browserConnected }) });
            expect(nativeClosed).toBe(true); expect(browserConnected).toBe(false);
          }
        }
      }
    }
  });
});
