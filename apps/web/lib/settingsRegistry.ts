/** Settings navigation metadata. Keep this leaf free of UI and panel imports. */
export const SETTINGS_GROUPS = [
  { id: "account", label: "Account", showHeading: true },
  { id: "gameplay", label: "Gameplay", showHeading: true },
  { id: "streaming", label: "Streaming", showHeading: true },
  { id: "preferences", label: "Preferences", showHeading: false },
  { id: "help", label: "Help", showHeading: false },
] as const;

export type SettingsGroupId = (typeof SETTINGS_GROUPS)[number]["id"];

export const SETTINGS_TABS = [
  { id: "account", group: "account", label: "Account", description: "Setup health, desktop app, diagnostics" },
  { id: "profile", group: "account", label: "Profile", description: "BattleTag, Pulse IDs, display name" },
  { id: "backups", group: "account", label: "Backups & data", description: "Snapshots, export, delete" },
  { id: "checkin", group: "gameplay", label: "Build check-in", description: "Choose when to record your planned build" },
  { id: "randomizer", group: "gameplay", label: "Randomizer", description: "Build choices and sound effects" },
  { id: "import", group: "gameplay", label: "Import", description: "Replay folders, history, import jobs" },
  { id: "overlay", group: "streaming", label: "Overlay", description: "OBS URLs, scenes, theme, chat" },
  { id: "voice", group: "streaming", label: "Voice", description: "Spoken scouting reports" },
  { id: "preferences", group: "preferences", label: "Preferences", description: "Start page, setup, browser choices" },
  { id: "help", group: "help", label: "Help", description: "Articles and troubleshooting" },
] as const satisfies readonly { id: string; group: SettingsGroupId; label: string; description: string }[];

export type SettingsTabId = (typeof SETTINGS_TABS)[number]["id"];

/** Old query and hash-only links continue to resolve to a canonical tab. */
export const SETTINGS_TAB_ALIASES: Readonly<Record<string, SettingsTabId>> = {
  foundation: "account",
  misc: "preferences",
  streaming: "overlay",
};

const TAB_BY_ALIAS: ReadonlyMap<string, SettingsTabId> = new Map(Object.entries(SETTINGS_TAB_ALIASES));

export function isSettingsTabId(value: unknown): value is SettingsTabId {
  return SETTINGS_TABS.some((tab) => tab.id === value);
}

/** Every tab is available; browser-import permissions stay inside Import. */
export function defaultTabVisibility(id: SettingsTabId): boolean {
  return isSettingsTabId(id);
}

export function settingsTabFromParam(value: string | null | undefined): SettingsTabId | null {
  if (!value) return null;
  return isSettingsTabId(value) ? value : TAB_BY_ALIAS.get(value) ?? null;
}

/** A section hash stays a section unless it names a registered tab or alias. */
export function settingsTabForLegacyHash(hash: string): SettingsTabId | null {
  return settingsTabFromParam(hash.replace(/^#/, "").toLowerCase());
}

export function visibleSettingsTabs(
  isTabVisible: (id: SettingsTabId) => boolean = defaultTabVisibility,
): SettingsTabId[] {
  return SETTINGS_TABS.filter((tab) => isTabVisible(tab.id)).map((tab) => tab.id);
}
