import type { HelpArticle } from "@/lib/help/types";
const article: HelpArticle = {
  slug: "stay-up-to-date", title: "Stay up to date", category: "account-data", audience: "all", order: 30, updated: "2026-10-23",
  summary: "Read product updates, check your desktop app version and understand service notices.", keywords: ["what's new", "changelog", "RSS", "agent update", "version", "incident", "maintenance"],
  body: [
    { type: "heading", text: "What's New and the changelog", anchor: "whats-new" },
    { type: "paragraph", text: "When signed in, the sparkle button beside the bell opens **What's new**. A dot means an update is newer than your last visit. The sheet follows your chosen goals: Improve, Stream, or both. Opening it saves your place across devices. If saving fails, use Retry." },
    { type: "paragraph", text: "The public [changelog](/changelog) lists every curated update. Filter it by Agent, Website, Stream Studio or Guides. Each update has a link you can share and a short guide. Use the **RSS feed** link to subscribe in your feed reader. Major updates also appear in [Notifications](/notifications), unless you mute **Major product updates**." },
    { type: "heading", text: "Desktop app updates", anchor: "desktop-updates" },
    { type: "paragraph", text: "Open the desktop app's **About** page or use its tray menu to check your version and check for updates. The [download page](/download) shows the latest installer, SHA-256 and readable release notes. Read [Install and pair](/help/install-and-pair) for installation and linking help. An update notification does not mean an installer has already been applied." },
    { type: "heading", text: "Service notices", anchor: "service-notices" },
    { type: "paragraph", text: "A notice below the app header explains maintenance, delayed uploads or another active issue. Follow its instructions and **More information** link. Non-critical notices can be dismissed in this browser. Critical notices stay visible until they end. Notices expire automatically; an older cached notice can take up to one minute to refresh. The desktop app also shows notices aimed at the agent when it checks the release feed." },
  ], related: ["notifications", "install-and-pair", "report-a-problem"],
};
export default article;
