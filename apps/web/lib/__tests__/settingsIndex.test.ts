import { describe, expect, it } from "vitest";
import { SETTINGS_SECTIONS, settingsSectionsForTab } from "../settingsIndex";
import { isSettingsTabId, SETTINGS_TABS } from "../settingsRegistry";

describe("Settings section catalog", () => {
  it("contains only registered tabs and unique, stable section targets", () => {
    for (const [tab, sections] of Object.entries(SETTINGS_SECTIONS)) {
      expect(isSettingsTabId(tab)).toBe(true);
      expect(new Set(sections.map(section => section.id)).size).toBe(sections.length);
      for (const section of sections) {
        expect(section.id).toMatch(/^[a-z]+(?:-[a-z]+)*$/);
        expect(section.label.trim()).not.toBe("");
      }
    }
    expect(SETTINGS_SECTIONS.overlay.map(section => section.id)).toEqual(["setup", "widgets", "scenes", "build-profile", "ghost-coach", "theme", "tokens"]);
    expect(SETTINGS_SECTIONS.chat.some(section => section.id === "tokens")).toBe(true);
  });
  it("does not invent sections or field/global search for other tabs", () => {
    for (const tab of SETTINGS_TABS) {
      if (tab.id === "overlay" || tab.id === "chat") expect(settingsSectionsForTab(tab.id)).toBe(SETTINGS_SECTIONS[tab.id]);
      else expect(settingsSectionsForTab(tab.id)).toEqual([]);
    }
  });
});
