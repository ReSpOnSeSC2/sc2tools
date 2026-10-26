import { describe, expect, it } from "vitest";
import {
  SETTINGS_GROUPS, SETTINGS_TABS, SETTINGS_TAB_ALIASES,
  defaultTabVisibility, isSettingsTabId, settingsTabFromParam,
  settingsTabForLegacyHash, visibleSettingsTabs, resolveSettingsDestination,
} from "../settingsRegistry";

describe("Settings registry", () => {
  it("places real tabs in the Account, Gameplay and Streaming groups", () => {
    const inGroup = (group: string) => SETTINGS_TABS.filter((tab) => tab.group === group).map((tab) => tab.id);
    expect(inGroup("account")).toEqual(["account", "profile", "backups"]);
    expect(inGroup("gameplay")).toEqual(["checkin", "randomizer", "import"]);
    expect(inGroup("streaming")).toEqual(["overlay", "chat", "voice"]);
    expect(inGroup("preferences")).toEqual(["preferences"]);
    expect(inGroup("help")).toEqual(["help"]);
    expect(isSettingsTabId("devices")).toBe(false);
    expect(isSettingsTabId("chat")).toBe(true);
    expect(new Set(SETTINGS_TABS.map((tab) => tab.id)).size).toBe(SETTINGS_TABS.length);
    for (const tab of SETTINGS_TABS) {
      expect(SETTINGS_GROUPS.some((group) => group.id === tab.group)).toBe(true);
      expect(tab.description.trim().length).toBeGreaterThan(0);
      expect(defaultTabVisibility(tab.id)).toBe(true);
    }
  });

  it.each([
    ["account", "account"], ["foundation", "account"],
    ["preferences", "preferences"], ["misc", "preferences"],
    ["streaming", "overlay"], ["overlay", "overlay"], ["chat", "chat"],
  ])("resolves %s to %s for query and legacy hash links", (input, canonical) => {
    expect(settingsTabFromParam(input)).toBe(canonical);
    expect(settingsTabForLegacyHash(`#${input.toUpperCase()}`)).toBe(canonical);
  });

  it("does not treat aliases as canonical IDs or inherited object names as tabs", () => {
    for (const [alias, target] of Object.entries(SETTINGS_TAB_ALIASES)) {
      expect(isSettingsTabId(alias)).toBe(false);
      expect(isSettingsTabId(target)).toBe(true);
    }
    for (const input of [null, undefined, "", "constructor", "__proto__", "nope", " account "]) {
      expect(settingsTabFromParam(input)).toBeNull();
    }
    expect(settingsTabForLegacyHash("#platform-connections")).toBeNull();
  });

  it("filters visibility without losing grouped keyboard order", () => {
    expect(visibleSettingsTabs((id) => !["profile", "import", "voice"].includes(id)))
      .toEqual(["account", "backups", "checkin", "randomizer", "overlay", "chat", "preferences", "help"]);
  });
});

describe("complete bounded Settings destinations", () => {
  it.each([
    ["tab=overlay&section=look&ref=keep", "", "/settings?tab=overlay&ref=keep#theme"],
    ["tab=overlay&section=widgets&widget=multichat", "#chat", "/settings?tab=overlay&widget=multichat#widgets"],
    ["tab=overlay&pack=first-stream", "#platform-connections", "/settings?tab=overlay&pack=first-stream#widgets"],
    ["tab=overlay&section=look", "#ghost-build", "/settings?tab=overlay#ghost-coach"],
    ["tab=overlay", "#ghost", "/settings?tab=overlay#ghost-coach"],
    ["tab=overlay", "#ghost-build", "/settings?tab=overlay#ghost-coach"],
    ["tab=overlay&section=tokens", "", "/settings?tab=overlay#tokens"],
    ["tab=chat&section=tts&ref=keep", "", "/settings?tab=chat&ref=keep#tts"],
  ])("canonicalizes a real section without losing extras: %s %s", (search, hash, href) => {
    const result = resolveSettingsDestination(search, hash);
    expect(result.href).toBe(href);
    const url = new URL(href, "https://fixture.invalid");
    expect(resolveSettingsDestination(url.search, url.hash)).toEqual(result);
  });
  it.each([
    ["tab=overlay&section=chat", "", "/settings?tab=chat"],
    ["tab=chat&section=chat", "#twitch-automation", "/settings?tab=chat#twitch-automation"],
    ["tab=chat&section=dock", "#stream-dock", "/settings?tab=chat#stream-dock"],
    ["tab=streaming&section=chat&ref=help", "#twitch-automation", "/settings?tab=chat&ref=help#twitch-automation"],
    ["tab=overlay&section=dock", "", "/settings?tab=chat#dock"],
    ["tab=overlay&section=setup", "#stream-dock", "/settings?tab=chat#stream-dock"],
    ["tab=overlay", "#platform-connections", "/settings?tab=chat#platform-connections"],
    ["tab=overlay", "#multichat", "/settings?tab=chat"],
    ["", "#chat", "/settings?tab=chat"],
    ["", "#stream-dock", "/settings?tab=chat#stream-dock"],
  ])("resolves %s %s before a streaming mount", (search, hash, href) => {
    const result = resolveSettingsDestination(search, hash);
    expect(result.tab).toBe("chat"); expect(result.href).toBe(href);
    expect(resolveSettingsDestination(href.split("?")[1].split("#")[0], result.hash)).toEqual(result);
  });
  it("preserves source-enable intent, remaining panes and nonmoved alias bytes", () => {
    expect(resolveSettingsDestination("tab=overlay&section=widgets&widget=multichat", "#chat")).toMatchObject({ tab: "overlay", overlayPane: "widgets" });
    expect(resolveSettingsDestination("tab=streaming&pack=first-stream", "#platform-connections")).toMatchObject({ tab: "overlay", overlayPane: "widgets" });
    expect(resolveSettingsDestination("tab=overlay&section=look", "#chat")).toMatchObject({ tab: "overlay", overlayPane: "look" });
    expect(resolveSettingsDestination("tab=misc&ref=keep%20space", "#notifications")).toMatchObject({ tab: "preferences", href: "/settings?tab=misc&ref=keep%20space#notifications" });
    expect(resolveSettingsDestination("tab=profile", "#chat").tab).toBe("profile");
  });
  it("does not guess chat from unknown, inherited or unbounded input", () => {
    for (const search of ["tab=constructor&section=chat", "tab=__proto__&section=dock", "tab=account&section=chat"]) expect(resolveSettingsDestination(search, "#chat").tab).toBe("account");
    expect(resolveSettingsDestination("tab=overlay&section=constructor", "#chat").tab).toBe("overlay");
    expect(resolveSettingsDestination("tab=overlay", "#unknown-chat-suffix").tab).toBe("overlay");
    expect(resolveSettingsDestination(`tab=overlay&ref=${"x".repeat(513)}`, "#chat").tab).toBe("account");
    expect(resolveSettingsDestination("tab=overlay", `#${"x".repeat(129)}`).tab).toBe("account");
  });
});
