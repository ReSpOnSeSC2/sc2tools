import type { SettingsTabId } from "./settingsRegistry";

/** Public UI labels only. Never import panels, hooks, permissions or private values. */
export type SettingsSectionEntry = { readonly id: string; readonly label: string };
export const SETTINGS_SECTIONS_READY_EVENT = "settings-sections-ready";
export const SETTINGS_SECTIONS = {
  account: [
    { id: "setup-health", label: "Setup health" },
    { id: "account-summary", label: "Account summary" },
    { id: "quick-links", label: "Quick links" },
  ],
  profile: [
    { id: "profile-details", label: "Profile" },
    { id: "pulse-ids", label: "Pulse IDs" },
    { id: "player-channels", label: "Twitch & YouTube" },
    { id: "public-profile", label: "Public player page" },
  ],
  backups: [
    { id: "replay-archive", label: "Replay archive" },
    { id: "snapshots", label: "Snapshots" },
    { id: "repair-data", label: "Repair my data" },
    { id: "hidden-games", label: "Hidden games" },
    { id: "delete-history", label: "Delete game history" },
    { id: "gdpr", label: "Export & delete account" },
  ],
  checkin: [{ id: "build-check-in", label: "Build check-in" }],
  randomizer: [
    { id: "build-randomizer", label: "Build randomizer" },
    { id: "catalog-builds", label: "Catalog builds" },
    { id: "custom-builds", label: "Build library" },
    { id: "gateway-draw", label: "Opening Gateway draw" },
    { id: "sound-effects", label: "Sound effects" },
    { id: "randomizer-preview", label: "Live preview" },
  ],
  import: [
    { id: "desktop-import", label: "Desktop agent import" },
    { id: "import-jobs", label: "Recent jobs" },
    { id: "browser-import", label: "Browser import" },
    { id: "folder-sync", label: "Folder Sync" },
  ],
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
  voice: [{ id: "voice-readout", label: "Voice readout" }],
  preferences: [
    { id: "app-preferences", label: "App preferences" },
    { id: "setup-privacy", label: "Setup & privacy" },
    { id: "notifications", label: "Notifications" },
  ],
  help: [],
} as const satisfies Record<SettingsTabId, readonly SettingsSectionEntry[]>;

export function settingsSectionsForTab(tab: SettingsTabId): readonly SettingsSectionEntry[] {
  return SETTINGS_SECTIONS[tab];
}

export type SettingsFieldEntry = {
  readonly id: string;
  readonly tab: SettingsTabId;
  readonly section: string;
  readonly label: string;
  readonly synonyms: readonly string[];
};

/** Conditional browser/Gateway tools resolve to their always-present parent.
 * Their exact targets belong to the admitted panel's live section navigation. */
export const SETTINGS_FIELDS = [
  { id: "setup-health", tab: "account", section: "setup-health", label: "Setup health", synonyms: ["desktop app", "agent connection", "diagnostics", "pairing"] },
  { id: "account-summary", tab: "account", section: "account-summary", label: "Account summary", synonyms: ["cloud user ID", "email", "games synced", "agent version", "latest sync"] },
  { id: "account-links", tab: "account", section: "quick-links", label: "Account quick links", synonyms: ["devices", "download agent", "build library"] },
  { id: "profile-name", tab: "profile", section: "profile-details", label: "Display name & BattleTag", synonyms: ["profile", "player name", "race", "battletag"] },
  { id: "profile-session-gap", tab: "profile", section: "profile-details", label: "Session inactivity gap", synonyms: ["session length", "session timeout", "90 minutes", "240 minutes", "overlay session"] },
  { id: "pulse-ids", tab: "profile", section: "pulse-ids", label: "Pulse IDs", synonyms: ["Pulse ID", "SC2Pulse", "identity", "regions"] },
  { id: "player-channels", tab: "profile", section: "player-channels", label: "Twitch & YouTube channels", synonyms: ["recording links", "player channels", "channel review"] },
  { id: "public-profile", tab: "profile", section: "public-profile", label: "Public player page", synonyms: ["profile privacy", "player link", "public profile", "slug"] },
  { id: "replay-archive", tab: "backups", section: "replay-archive", label: "Cloud Replay Archive", synonyms: ["original replays", "replay backups", "download replay", "archive storage"] },
  { id: "snapshots", tab: "backups", section: "snapshots", label: "Account snapshots", synonyms: ["restore point", "snapshot", "backup account"] },
  { id: "repair-data", tab: "backups", section: "repair-data", label: "Repair my data", synonyms: ["recalculate", "wrong counts", "repair records", "archive recheck"] },
  { id: "hidden-games", tab: "backups", section: "hidden-games", label: "Hidden games", synonyms: ["unhide", "pending deletion", "hidden replays"] },
  { id: "delete-history", tab: "backups", section: "delete-history", label: "Delete game history", synonyms: ["wipe games", "reset replay history", "delete replays"] },
  { id: "gdpr", tab: "backups", section: "gdpr", label: "Export & delete account", synonyms: ["Delete account", "GDPR", "export data", "privacy export"] },
  { id: "build-check-in", tab: "checkin", section: "build-check-in", label: "Build check-in prompts", synonyms: ["planned build", "loading screen", "after each game", "check in"] },
  { id: "randomizer-pool", tab: "randomizer", section: "build-randomizer", label: "Build randomizer pool", synonyms: ["matchup", "build choices", "catalog builds", "custom weights", "Gateway units", "opening unit draw"] },
  { id: "randomizer-sounds", tab: "randomizer", section: "sound-effects", label: "Randomizer sound effects", synonyms: ["randomizer volume", "fanfare", "reveal sounds"] },
  { id: "randomizer-preview", tab: "randomizer", section: "randomizer-preview", label: "Randomizer live preview", synonyms: ["spin preview", "build reveal"] },
  { id: "desktop-import", tab: "import", section: "desktop-import", label: "Replay import", synonyms: ["desktop import", "browser import", "Folder Sync", "replay folders", "re-scan", "replay history"] },
  { id: "import-jobs", tab: "import", section: "import-jobs", label: "Recent import jobs", synonyms: ["import progress", "previous imports", "import runs"] },
  { id: "overlay-setup", tab: "overlay", section: "setup", label: "OBS overlay setup", synonyms: ["streaming", "overlay connection", "starter packs"] },
  { id: "overlay-widgets", tab: "overlay", section: "widgets", label: "Overlay widgets", synonyms: ["OBS sources", "Browser Source", "widget URLs"] },
  { id: "overlay-scenes", tab: "overlay", section: "scenes", label: "Overlay scenes", synonyms: ["scene layouts", "scene URLs"] },
  { id: "build-profile", tab: "overlay", section: "build-profile", label: "Build profile", synonyms: ["build display", "build order overlay"] },
  { id: "ghost-coach", tab: "overlay", section: "ghost-coach", label: "Ghost Build coach", synonyms: ["practice", "ghost replay", "ghost settings"] },
  { id: "overlay-theme", tab: "overlay", section: "theme", label: "Overlay theme", synonyms: ["overlay colors", "overlay look", "widget appearance"] },
  { id: "overlay-tokens", tab: "overlay", section: "tokens", label: "Reset overlay URLs", synonyms: ["tokens", "rotate URLs", "revoke token", "private streaming links"] },
  { id: "chat-platforms", tab: "chat", section: "platforms", label: "Chat platforms & Kick chatroom", synonyms: ["Kick chatroom", "Twitch connection", "YouTube chat", "TikTok", "platforms"] },
  { id: "chat-appearance", tab: "chat", section: "appearance", label: "Chat appearance", synonyms: ["chat font", "chat colors", "chat layout"] },
  { id: "chat-alerts", tab: "chat", section: "alerts", label: "Chat alerts", synonyms: ["alert sounds", "stream alerts", "chat events"] },
  { id: "chat-tts", tab: "chat", section: "tts", label: "Text-to-speech", synonyms: ["TTS volume", "text to speech", "read chat aloud", "chat voice"] },
  { id: "chat-translation", tab: "chat", section: "translation", label: "Chat translation", synonyms: ["translate", "chat language"] },
  { id: "chat-commands", tab: "chat", section: "commands", label: "Chat commands", synonyms: ["Nightbot", "command snippets", "rank command"] },
  { id: "twitch-automation", tab: "chat", section: "twitch-automation", label: "Twitch automation", synonyms: ["predictions", "channel points"] },
  { id: "stream-dock", tab: "chat", section: "dock", label: "Stream Dock", synonyms: ["Dock URL", "OBS dock", "stream controls"] },
  { id: "chat-bot", tab: "chat", section: "bot", label: "Chat bot", synonyms: ["bot account", "bot login", "chatbot"] },
  { id: "voice-readout", tab: "voice", section: "voice-readout", label: "Voice readout", synonyms: ["scouting voice", "speech volume", "voice notifications", "spoken opponent"] },
  { id: "app-preferences", tab: "preferences", section: "app-preferences", label: "Default tab", synonyms: ["start page", "app preferences", "default dashboard"] },
  { id: "setup-privacy", tab: "preferences", section: "setup-privacy", label: "Setup & privacy", synonyms: ["analytics cookies", "cookie consent", "setup guide", "setup checklist"] },
  { id: "notifications", tab: "preferences", section: "notifications", label: "Notification preferences", synonyms: ["mute notifications", "in-app updates", "notifications"] },
] as const satisfies readonly SettingsFieldEntry[];

export function settingsFieldHref(field: SettingsFieldEntry): string {
  return `/settings?tab=${field.tab}#${field.section}`;
}
