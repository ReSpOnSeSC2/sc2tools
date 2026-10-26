import { expect, test } from "@playwright/test";
import { mkdir } from "node:fs/promises";
import path from "node:path";
import { checkAccessibility } from "./accessibility-check";
import { closeSettingsChatFixtureServer, openSettingsChatFixture } from "./settings-chat-fixture.mjs";

type ChatWindow = typeof window & { chatNavigate: (href: string) => void; chatSetOwner: (owner: string) => void; chatPushes: () => string[] };
const shots = path.resolve(process.env.SETTINGS_CHAT_SHOTS_DIR ?? path.join("../../.cache", `settings-chat-browser-${Date.now()}`));
test.afterAll(async ({ browserName }, info) => {
  const receipt = await closeSettingsChatFixtureServer();
  expect(receipt.closed).toBe(true); expect(receipt.listening).toBe(false);
  await info.attach("chat-loopback-cleanup", { contentType: "application/json", body: JSON.stringify({ browserName, ...receipt }) });
});

for (const theme of ["light", "dark"] as const) {
  test(`Chat ${theme}: actual forms, shared token, dirty guard, owners and native Devices`, async ({ page }, info) => {
    test.setTimeout(120_000);
    const evidence = await openSettingsChatFixture(page, theme);
    expect(evidence.reads).toEqual([]); expect(evidence.writes).toEqual([]);
    await expect(page.locator("html")).toHaveAttribute("data-theme", theme);
    await expect(page.locator("html")).toHaveAttribute("data-theme-mode", theme);
    expect(await page.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue("--bg").trim().replace(/\s+/g, " "))).toBe(theme === "light" ? "244 246 250" : "6 9 14");
    expect(await page.evaluate(() => getComputedStyle(document.body).fontFamily)).toContain("SettingsHanken");
    await page.evaluate(() => (window as ChatWindow).chatNavigate("/settings?tab=overlay&section=chat&ref=legacy#platform-connections"));
    await expect(page).toHaveURL(/\/settings\?tab=chat&ref=legacy#platform-connections$/);
    const panel = page.getByRole("tabpanel", { name: "Chat & alerts", exact: true });
    const list = page.getByRole("tablist", { name: "Settings sections", exact: true });
    const manager = page.getByRole("region", { name: "Shared streaming token controls", exact: true });
    await expect(manager).toHaveCount(1);
    await expect(panel.getByLabel(/Loyalty rank theme/)).toBeVisible();
    await expect(panel.getByRole("button", { name: "Save bot settings", exact: true })).toBeVisible();
    await expect(panel.locator("#platform-connections")).toHaveAttribute("data-section-flash", /.+/);
    for (const id of ["platforms", "platform-connections", "appearance", "alerts", "tts", "translation", "commands", "dock", "stream-dock", "bot", "twitch-automation"]) await expect(panel.locator(`[id="${id}"]`)).toHaveCount(1);
    expect(evidence.reads.filter(row => row.path === "/v1/overlay-tokens")).toEqual([{ owner: "owner-a", path: "/v1/overlay-tokens" }]);
    expect(evidence.writes).toEqual([]);
    await mkdir(shots, { recursive: true });
    await manager.scrollIntoViewIfNeeded();
    await checkAccessibility(page, info, "/settings-chat-loaded", theme);
    await page.screenshot({ path: path.join(shots, `${info.project.name}-${theme}-chat.png`) });

    await panel.getByLabel(/Loyalty rank theme/).selectOption("zerg");
    await panel.getByLabel("Bot username", { exact: true }).fill("synthetic-bot");
    await expect(manager.getByRole("combobox", { name: "URLs shown for", exact: true })).toBeDisabled();
    await expect(manager.getByRole("button", { name: "Rotate", exact: true })).toBeDisabled();
    await list.getByRole("tab", { name: "Overlay", exact: true }).click();
    const guard = page.getByRole("dialog", { name: "Discard unsaved changes?", exact: true });
    await expect(guard).toBeVisible();
    const discard = guard.getByRole("button", { name: "Discard & switch", exact: true });
    await discard.focus(); await page.keyboard.press("Tab"); await expect(guard.getByRole("button", { name: "Close", exact: true })).toBeFocused();
    await page.keyboard.press("Escape");
    await expect(guard).toHaveCount(0);
    await expect(panel.getByLabel("Bot username", { exact: true })).toHaveValue("synthetic-bot");
    await expect(page).toHaveURL(/\?tab=chat&ref=legacy#platform-connections$/);
    expect(evidence.writes).toEqual([]);

    await panel.getByRole("button", { name: "Save bot settings", exact: true }).click();
    await expect(panel.getByRole("button", { name: "Save bot settings", exact: true })).toBeDisabled();
    await expect(manager.getByRole("combobox", { name: "URLs shown for", exact: true })).toBeDisabled();
    await panel.getByRole("button", { name: "Save chat settings", exact: true }).click();
    await expect(manager.getByRole("combobox", { name: "URLs shown for", exact: true })).toBeEnabled();
    expect(evidence.writes).toEqual([
      { owner: "owner-a", method: "PUT", path: "/v1/me/chatbot" },
      { owner: "owner-a", method: "PUT", path: "/v1/me/preferences/multichat" },
    ]);
    await manager.getByRole("combobox", { name: "URLs shown for", exact: true }).selectOption("owner-a-two");
    await list.getByRole("tab", { name: "Overlay", exact: true }).click();
    await expect(page.getByRole("heading", { name: "Synthetic Overlay body", exact: true })).toBeVisible();
    await expect(page.getByText("Selected source: owner-a two.", { exact: false })).toBeVisible();
    await expect(manager.getByRole("combobox", { name: "URLs shown for", exact: true })).toHaveValue("owner-a-two");
    await page.getByLabel("Overlay profile draft", { exact: true }).fill("keep profile draft");
    await expect(manager.getByRole("combobox", { name: "URLs shown for", exact: true })).toBeDisabled();
    await list.getByRole("tab", { name: "Chat & alerts", exact: true }).click();
    await expect(guard).toBeVisible(); await guard.getByRole("button", { name: "Stay on this tab", exact: true }).click();
    await expect(page.getByLabel("Overlay profile draft", { exact: true })).toHaveValue("keep profile draft");
    await list.getByRole("tab", { name: "Chat & alerts", exact: true }).click();
    await guard.getByRole("button", { name: "Discard & switch", exact: true }).click();
    await expect(manager.getByRole("combobox", { name: "URLs shown for", exact: true })).toHaveValue("owner-a-two");
    expect(evidence.reads.filter(row => row.path === "/v1/overlay-tokens")).toHaveLength(1);

    await page.evaluate(() => (window as ChatWindow).chatSetOwner("owner-b"));
    await expect(manager.getByRole("combobox", { name: "URLs shown for", exact: true })).toHaveValue("owner-b-one");
    await expect(panel.getByLabel("Bot username", { exact: true })).toHaveValue("");
    await page.evaluate(() => (window as ChatWindow).chatSetOwner("owner-a"));
    await expect(manager.getByRole("combobox", { name: "URLs shown for", exact: true })).toHaveValue("owner-a-one");
    expect(evidence.reads.filter(row => row.path === "/v1/overlay-tokens")).toEqual([
      { owner: "owner-a", path: "/v1/overlay-tokens" }, { owner: "owner-b", path: "/v1/overlay-tokens" }, { owner: "owner-a", path: "/v1/overlay-tokens" },
    ]);
    await page.evaluate(() => (window as ChatWindow).chatNavigate("/settings?tab=overlay&section=setup#stream-dock"));
    await expect(page).toHaveURL(/\?tab=chat#stream-dock$/);
    await expect(panel.locator("#stream-dock")).toHaveAttribute("data-section-flash", /.+/);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await checkAccessibility(page, info, "/settings-chat-dock", theme);
    await page.screenshot({ path: path.join(shots, `${info.project.name}-${theme}-dock.png`) });

    // Phone layout/AA is complete before this real desktop-only native link.
    if (page.viewportSize()!.width < 1024) await page.setViewportSize({ width: 1280, height: 900 });
    await panel.getByLabel("Bot username", { exact: true }).fill("retained-native-draft");
    const devices = page.getByRole("navigation", { name: "Settings navigation", exact: true }).getByRole("link", { name: "Devices", exact: true });
    const current = page.url(), priorPushes = await page.evaluate(() => (window as ChatWindow).chatPushes());
    const popup = page.context().waitForEvent("page"); await devices.click({ modifiers: ["Control"] });
    const native = await popup; await expect(native.getByRole("heading", { name: "Devices destination", exact: true })).toBeVisible(); await native.close(); await page.bringToFront();
    await expect(page).toHaveURL(current); await expect(guard).toHaveCount(0);
    await expect(panel.getByLabel("Bot username", { exact: true })).toHaveValue("retained-native-draft");
    expect(await page.evaluate(() => (window as ChatWindow).chatPushes())).toEqual(priorPushes);
    await devices.click(); await expect(guard).toBeVisible();
    await guard.getByRole("button", { name: "Stay on this tab", exact: true }).click();
    await expect(panel.getByLabel("Bot username", { exact: true })).toHaveValue("retained-native-draft");
    await devices.focus(); await page.keyboard.press("Enter");
    await guard.getByRole("button", { name: "Discard & open Devices", exact: true }).click();
    await expect(page.getByRole("heading", { name: "Devices destination", exact: true })).toBeVisible();
    expect(await page.evaluate(() => (window as ChatWindow).chatPushes())).toEqual([...priorPushes, "/devices"]);
    expect(evidence.deviceLoads).toEqual(["GET"]);
    expect(evidence.errors).toEqual([]); expect(evidence.unexpectedRequests).toEqual([]); expect(evidence.rejectedWrites).toEqual([]); expect(evidence.externalAttempts).toEqual([]);
    await info.attach("chat-exact-transport", { contentType: "application/json", body: JSON.stringify({ ...evidence, releaseAll: undefined, syntheticConsentWrites: 0, syntheticPreferencePUTs: 2, actualAccountOrProviderWrites: 0 }) });
  });

  test(`Chat ${theme}: lost Default ACK survives leaving and empty status without reminting`, async ({ page }, info) => {
    test.setTimeout(90_000);
    const evidence = await openSettingsChatFixture(page, theme, "unknown");
    const list = page.getByRole("tablist", { name: "Settings sections", exact: true });
    await list.getByRole("tab", { name: "Chat & alerts", exact: true }).click();
    await expect(page.getByRole("tabpanel", { name: "Chat & alerts", exact: true })).toBeVisible();
    await expect.poll(() => evidence.writes.length).toBe(1);
    await list.getByRole("tab", { name: "Account", exact: true }).click();
    await expect(page.getByRole("heading", { name: "account synthetic panel", exact: true })).toBeVisible();
    await list.getByRole("tab", { name: "Chat & alerts", exact: true }).click();
    await expect(page.getByText("A token change may have completed. Check status before creating another token.", { exact: true })).toBeVisible();
    await page.getByRole("button", { name: "Check token status", exact: true }).click();
    await expect.poll(() => evidence.reads.filter(row => row.path === "/v1/overlay-tokens").length).toBe(3);
    await expect(page.getByRole("button", { name: "Create a token explicitly", exact: true })).toBeVisible();
    expect(evidence.writes).toEqual([{ owner: "owner-a", method: "POST", path: "/v1/overlay-tokens" }]);
    await evidence.releaseAll();
    await expect(page.getByRole("button", { name: "Create a token explicitly", exact: true })).toBeVisible();
    await expect(page.getByLabel("URLs shown for", { exact: true })).toHaveCount(0);
    const panel = page.getByRole("tabpanel", { name: "Chat & alerts", exact: true });
    await expect(panel).toBeVisible();
    expect(await page.getByRole("tablist", { name: "Settings sections", exact: true }).getByRole("tab").evaluateAll(tabs => tabs.every(tab => document.getElementById(tab.getAttribute("aria-controls") ?? "")?.getAttribute("role") === "tabpanel"))).toBe(true);
    await expect(panel.getByLabel("Bot username", { exact: true })).toHaveCount(0);
    await expect(panel.locator("#platform-connections")).toHaveCount(0);
    await checkAccessibility(page, info, "/settings-chat-unknown-status", theme);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await mkdir(shots, { recursive: true }); await page.screenshot({ path: path.join(shots, `${info.project.name}-${theme}-unknown.png`) });
    expect(evidence.errors).toEqual([]); expect(evidence.unexpectedRequests).toEqual([]); expect(evidence.rejectedWrites).toEqual([]); expect(evidence.externalAttempts).toEqual([]);
    await info.attach("chat-unknown-transport", { contentType: "application/json", body: JSON.stringify({ ...evidence, releaseAll: undefined, syntheticTokenPOSTs: 1, actualAccountOrProviderWrites: 0 }) });
  });
}
