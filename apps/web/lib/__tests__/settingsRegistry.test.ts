import { describe, expect, it } from "vitest";
import {
  SETTINGS_GROUPS, SETTINGS_TABS, SETTINGS_TAB_ALIASES,
  defaultTabVisibility, isSettingsTabId, settingsTabFromParam,
  settingsTabForLegacyHash, visibleSettingsTabs,
} from "../settingsRegistry";

describe("Settings registry", () => {
  it("places real tabs in the Account, Gameplay and Streaming groups", () => {
    const inGroup = (group: string) => SETTINGS_TABS.filter((tab) => tab.group === group).map((tab) => tab.id);
    expect(inGroup("account")).toEqual(["account", "profile", "backups"]);
    expect(inGroup("gameplay")).toEqual(["checkin", "randomizer", "import"]);
    expect(inGroup("streaming")).toEqual(["overlay", "voice"]);
    expect(inGroup("preferences")).toEqual(["preferences"]);
    expect(inGroup("help")).toEqual(["help"]);
    expect(isSettingsTabId("devices")).toBe(false);
    expect(isSettingsTabId("chat")).toBe(false);
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
    ["streaming", "overlay"], ["overlay", "overlay"],
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
      .toEqual(["account", "backups", "checkin", "randomizer", "overlay", "preferences", "help"]);
  });
});
