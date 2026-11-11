import type { HelpArticle } from "@/lib/help/types";

const article: HelpArticle = {
  slug: "desktop-app-shortcuts",
  title: "Keyboard shortcuts in the desktop app",
  summary: "Navigate SC2 Tools on Windows, save Settings, and search the Activity log from the keyboard.",
  category: "desktop-app",
  audience: "all",
  order: 14,
  keywords: ["keyboard shortcuts", "navigation", "ctrl s", "f5", "accessibility"],
  related: ["desktop-app-overview", "desktop-app-settings", "desktop-app-activity-log"],
  updated: "2026-11-11",
  body: [
    { type: "list", items: [
      "**Ctrl+1–6** opens Companion, Dashboard, Recent games, Streams, Activity log, or Settings.",
      "**Ctrl+,** opens Settings. **Ctrl+S** saves pending changes on the Settings page.",
      "**Ctrl+F** opens Activity log search. Use **Enter** or **F3** for the next match, and add **Shift** to go back.",
      "**F5** refreshes the current data page. Use **Up** and **Down** to move between sidebar buttons and **Enter** to open the focused page.",
    ] },
  ],
};

export default article;
