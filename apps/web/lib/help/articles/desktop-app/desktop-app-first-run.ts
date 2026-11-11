import type { HelpArticle } from "@/lib/help/types";

const article: HelpArticle = {
  slug: "desktop-app-first-run",
  title: "First-run desktop setup",
  summary: "Link the Windows app and choose which StarCraft II replay folders and history to sync.",
  category: "desktop-app",
  audience: "all",
  order: 12,
  keywords: ["first run", "setup", "watch folders", "history", "last 30 days"],
  related: ["install-and-pair", "desktop-app-sync-range", "desktop-app-settings"],
  updated: "2026-11-11",
  body: [
    { type: "paragraph", text: "Open SC2 Tools and link the PC using the six-digit code. A first-time desktop install asks what to sync before it starts watching for replays. A PC that was already linked before this setup was introduced keeps syncing with its existing settings." },
    { type: "steps", items: [
      "**Folders:** check the StarCraft II accounts you want to include. Use **Add folder** for replays stored somewhere else.",
      "**History:** choose This season, Last 30 days, Everything, or Only new games. Choose **This season** if you have years of replays. Counts are estimates from replay file dates.",
      "**Preferences:** choose whether SC2 Tools starts with Windows. Press **Start syncing** once to save all three steps.",
    ] },
    { type: "paragraph", text: "Only new games starts from the moment setup is saved. You can widen the range later in Settings." },
  ],
};

export default article;
