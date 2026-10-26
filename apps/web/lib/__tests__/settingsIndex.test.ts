import { describe, expect, it } from "vitest";
import { SETTINGS_FIELDS, SETTINGS_SECTIONS, settingsFieldHref, settingsSectionsForTab } from "../settingsIndex";
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
  it("registers complete actual section lists while Help keeps its article navigation", () => {
    for (const tab of SETTINGS_TABS) {
      expect(settingsSectionsForTab(tab.id)).toBe(SETTINGS_SECTIONS[tab.id]);
    }
    expect(SETTINGS_SECTIONS.help).toEqual([]);
    expect(SETTINGS_SECTIONS.preferences.map(section => section.id)).toEqual(["app-preferences", "setup-privacy", "notifications"]);
    expect(SETTINGS_SECTIONS.randomizer).toHaveLength(6);
    expect(SETTINGS_SECTIONS.import.map(section => section.id)).toContain("folder-sync");
  });
  it("indexes only registered tabs and real section destinations with unique field keys", () => {
    expect(new Set(SETTINGS_FIELDS.map(field => field.id)).size).toBe(SETTINGS_FIELDS.length);
    for (const field of SETTINGS_FIELDS) {
      expect(isSettingsTabId(field.tab)).toBe(true);
      expect(settingsSectionsForTab(field.tab).some(section => section.id === field.section)).toBe(true);
      expect(settingsFieldHref(field)).toBe(`/settings?tab=${field.tab}#${field.section}`);
      expect(field.label.trim()).not.toBe("");
    }
  });
  it.each([
    ["TTS volume", "chat", "tts"], ["Kick chatroom", "chat", "platforms"],
    ["Pulse ID", "profile", "pulse-ids"], ["Delete account", "backups", "gdpr"],
    ["Overlay theme", "overlay", "theme"], ["Reset overlay URLs", "overlay", "tokens"],
  ])("resolves canonical field query %s without a private lookup", (query, tab, section) => {
    const matches = SETTINGS_FIELDS.filter(field => [field.label, ...field.synonyms].some(label => label.toLowerCase().includes(query.toLowerCase())));
    expect(matches).toHaveLength(1);
    expect(matches[0]).toMatchObject({ tab, section });
  });
  it("does not promise unavailable browser-import or Gateway DOM from the global field search", () => {
    expect(SETTINGS_FIELDS.some(field => ["browser-import", "folder-sync", "gateway-draw"].includes(field.section))).toBe(false);
  });
});
