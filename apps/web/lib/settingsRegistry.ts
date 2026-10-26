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
  { id: "overlay", group: "streaming", label: "Overlay", description: "OBS sources, widgets, scenes and theme" },
  { id: "chat", group: "streaming", label: "Chat & alerts", description: "Platforms, alerts, TTS, Dock and bot" },
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

export const OVERLAY_PANES = ["setup", "widgets", "look", "scenes", "tokens"] as const;
export type SettingsOverlayPane = (typeof OVERLAY_PANES)[number];
export type SettingsDestination = {
  tab: SettingsTabId;
  href: string;
  hash: string;
  overlayPane: SettingsOverlayPane;
};

const CHAT_ANCHORS: ReadonlyMap<string, string> = new Map([
  ["chat", ""], ["multichat", ""], ["platforms", "platforms"],
  ["platform-connections", "platform-connections"], ["appearance", "appearance"],
  ["alerts", "alerts"], ["tts", "tts"], ["translation", "translation"],
  ["commands", "commands"], ["twitch-automation", "twitch-automation"],
  ["dock", "dock"], ["stream-dock", "stream-dock"], ["bot", "bot"],
]);
const OVERLAY_ANCHORS: ReadonlyMap<string, SettingsOverlayPane> = new Map([
  ["ghost", "look"], ["ghost-build", "look"], ["theme", "look"],
  ["build-profile", "look"], ["scenes", "scenes"],
]);

/** Pure, bounded legacy admission. It never mounts a panel or creates a token. */
export function resolveSettingsDestination(
  search: string,
  hash = "",
  fallback: SettingsTabId = "account",
): SettingsDestination {
  const safeFallback = isSettingsTabId(fallback) ? fallback : "account";
  const base = (tab: SettingsTabId): SettingsDestination => ({ tab, href: `/settings?tab=${tab}`, hash: "", overlayPane: "setup" });
  if (search.length > 4096 || hash.length > 128) return base("account");
  const query = new URLSearchParams(search);
  const entries = Array.from(query.entries());
  if (entries.length > 32 || entries.some(([key, value]) => key.length > 64 || value.length > 512)) return base("account");
  const rawTab = query.get("tab");
  const anchor = hash.replace(/^#/, "");
  const legacyTab = !rawTab ? settingsTabForLegacyHash(hash) : null;
  let tab = settingsTabFromParam(rawTab) ?? legacyTab ?? safeFallback;
  let targetHash = legacyTab ? "" : hash;
  let rewritten = !!legacyTab;
  let pane: SettingsOverlayPane = "setup";
  const section = query.get("section");
  const remaining = OVERLAY_PANES.find(id => id === section);
  if (remaining) pane = remaining;
  else if (query.has("widget") || query.has("pack")) pane = "widgets";
  else pane = OVERLAY_ANCHORS.get(anchor) ?? "setup";

  const hasSourceIntent = query.has("widget") || query.has("pack");
  const movedHash = CHAT_ANCHORS.get(anchor);
  // Explicit other tabs retain their section hashes. A widget/pack URL always
  // remains an Overlay source-enable intent, even if it carries an old hash.
  const canMove = (tab === "overlay" || !rawTab && !legacyTab) && !hasSourceIntent;
  if (canMove && (section === "chat" || section === "dock" ||
      (section === null || section === "setup") && movedHash !== undefined)) {
    tab = "chat";
    targetHash = movedHash !== undefined ? (movedHash ? `#${movedHash}` : "") : section === "dock" ? "#dock" : "";
    query.set("tab", "chat");
    query.delete("section");
    rewritten = true;
  }
  if (tab === "chat" && (section === "chat" || section === "dock")) {
    query.delete("section"); rewritten = true;
    if (!targetHash && section === "dock") targetHash = "#dock";
  }
  if (legacyTab) query.set("tab", tab);
  // Keep valid old query aliases/extras intact until an explicit tab action.
  const href = `/settings${query.size ? `?${query}` : ""}${targetHash}`;
  return { tab, href: rewritten ? href : `/settings${search ? `?${search.replace(/^\?/, "")}` : ""}${targetHash}`, hash: targetHash, overlayPane: pane };
}
