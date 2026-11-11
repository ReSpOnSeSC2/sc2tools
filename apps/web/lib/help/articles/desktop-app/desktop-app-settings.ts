import type { HelpArticle } from "@/lib/help/types";

const article: HelpArticle = {
  slug: "desktop-app-settings",
  title: "Desktop app settings",
  summary: "See which settings save immediately, which need Save, and when to restart SC2 Tools.",
  category: "desktop-app",
  audience: "all",
  order: 13,
  keywords: ["desktop settings", "restart", "save", "revert", "sync date range", "API address"],
  related: ["desktop-app-first-run", "desktop-app-shortcuts", "desktop-app-overview"],
  updated: "2026-11-11",
  body: [
    { type: "list", items: [
      "**Applies instantly:** upload concurrency, the OBS scene-switching master switch, automatic map replay capture, and Build check-in toggles.",
      "**Saved with Save:** sync date range, start with Windows, start minimized, desktop notifications, close behavior, automatic updates, upload batch size, and OBS connection details and scene mappings.",
      "**Needs restart:** API address, log level, and import worker count. After saving one of these, use **Restart agent now** to apply it.",
    ] },
    { type: "paragraph", text: "Use **Off**, **Important**, or **Every game** for desktop notifications. Choose whether closing the window keeps syncing in the tray or quits SC2 Tools." },
    { type: "paragraph", text: "The unsaved-change count appears when you edit a setting that needs Save. Choose **Revert** to restore the saved values or press **Ctrl+S** to save. Leaving the page prompts you before it discards changes." },
    { type: "paragraph", text: "The API address is for self-hosted and development installations. Leave it blank or use **Reset to default** for sc2tools.com. **Test** checks reachability." },
  ],
};

export default article;
