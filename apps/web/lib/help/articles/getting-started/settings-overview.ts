import type { HelpArticle } from "@/lib/help/types";

const article: HelpArticle = {
  slug: "settings-overview",
  title: "Finding things in Settings",
  summary:
    "What each Settings tab is for, how to open a tab or section straight from a link, and where to run setup again or change analytics cookies.",
  category: "getting-started",
  audience: "all",
  signedInOnly: true,
  order: 3,
  keywords: [
    "settings",
    "preferences",
    "tabs",
    "where is",
    "find a setting",
    "link",
    "deep link",
    "tab link",
    "unsaved changes",
    "discard",
    "default tab",
    "landing page",
    "start page",
    "setup again",
    "setup guide",
    "wizard",
    "onboarding",
    "analytics",
    "cookies",
    "privacy",
    "telemetry",
  ],
  updated: "2026-10-23",
  body: [
    {
      type: "paragraph",
      text: "[Settings](/settings) holds your account, overlay and preferences, one tab per job. Edits stay in draft until you press **Save**.",
    },
    { type: "heading", text: "What each tab is for" },
    {
      type: "table",
      head: ["Tab", "What it's for"],
      rows: [
        ["Foundation", "Your account at a glance (email, games synced, desktop app version) and quick links to Devices, Download and your build library."],
        ["Profile", "Your BattleTag, SC2Pulse IDs and display name, so your games and opponents are matched to you."],
        ["Overlay", "OBS widget URLs, overlay tokens and themes, the Ghost Build coach, multi-platform chat, the chat bot and your connected Twitch, Kick and YouTube accounts."],
        ["Randomizer", "Which builds the build randomizer picks from, and its sound effects."],
        ["Build check-in", "When the desktop app asks which build you were going for."],
        ["Voice", "The scouting report read aloud through your overlay."],
        ["Import", "Analyze replays in your browser without the desktop app. Only shown when browser import is on for your account."],
        ["Backups & data", "Snapshots, deleting your game history, and exporting or deleting your account."],
        ["Misc", "The page SC2 Tools opens on, running setup again, and analytics cookies for this browser."],
        ["Help", "These help articles, with search."],
      ],
    },
    { type: "heading", text: "Open a tab from a link" },
    {
      type: "list",
      items: [
        "Add `?tab=` and the tab's name to the Settings address to open that tab, for example [/settings?tab=overlay](/settings?tab=overlay). The names are `foundation`, `profile`, `overlay`, `randomizer`, `checkin`, `voice`, `import`, `backups`, `misc` and `help`.",
        "Add `#` and a section name to jump to one section of the tab. `/settings?tab=overlay#platform-connections` opens **Connected accounts** on the Overlay tab. The section is outlined for a moment so you can spot it.",
        "Older links that use `#overlay` instead of `?tab=overlay` still open the right tab.",
        "Picking a tab updates the address, so a copied link or a refresh brings you back to the same tab.",
      ],
    },
    { type: "heading", text: "Unsaved changes" },
    {
      type: "paragraph",
      text: "A dot next to a tab's name means it has edits you haven't saved. Switch tabs with unsaved edits and Settings asks first: **Stay on this tab** keeps them, **Discard & switch** drops them. On the Overlay tab this covers every form with its own Save button, including Multi-platform chat and the chat bot.",
    },
    { type: "heading", text: "Start page, setup and analytics (Misc)" },
    {
      type: "list",
      items: [
        "**Default tab** picks the page SC2 Tools opens on. **Today (default)** keeps you on the dashboard. Choose a section such as Opponents or Maps to land there once per visit; you can still go back to Today.",
        "**Run setup again** reopens the setup guide: download the desktop app, pair it and import your replays. Your games and settings stay as they are.",
        "**Analytics cookies** shows whether Google Analytics is on in this browser. Press **Turn on** or **Turn off** to change it; it takes effect right away. The choice only applies to the browser you're using, the same as the cookie banner.",
      ],
    },
    { type: "settingsLink", label: "Open Settings", href: "/settings" },
  ],
  related: ["getting-started", "how-to-use-help", "obs-overlay-setup"],
};

export default article;
