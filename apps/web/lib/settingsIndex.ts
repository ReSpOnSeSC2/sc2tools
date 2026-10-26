import type { SettingsTabId } from "./settingsRegistry";

/** Section metadata only. Panels, hooks and field/global search stay out of this leaf. */
export type SettingsSectionEntry = { readonly id: string; readonly label: string };
export const SETTINGS_SECTIONS = {
  overlay: [
    { id: "setup", label: "Setup" },
    { id: "widgets", label: "Widgets" },
    { id: "scenes", label: "Scenes" },
    { id: "build-profile", label: "Build profile" },
    { id: "ghost-coach", label: "Ghost Build coach" },
    { id: "theme", label: "Theme" },
    { id: "tokens", label: "Tokens" },
  ],
  chat: [
    { id: "platforms", label: "Platforms" },
    { id: "appearance", label: "Appearance" },
    { id: "alerts", label: "Alerts" },
    { id: "tts", label: "Text to speech" },
    { id: "translation", label: "Translation" },
    { id: "commands", label: "Commands" },
    { id: "twitch-automation", label: "Twitch automation" },
    { id: "dock", label: "Stream Dock" },
    { id: "bot", label: "Bot" },
    { id: "tokens", label: "Tokens" },
  ],
} as const satisfies Partial<Record<SettingsTabId, readonly SettingsSectionEntry[]>>;

export function settingsSectionsForTab(tab: SettingsTabId): readonly SettingsSectionEntry[] {
  return tab === "overlay" || tab === "chat" ? SETTINGS_SECTIONS[tab] : [];
}
