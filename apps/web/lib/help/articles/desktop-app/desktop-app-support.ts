import type { HelpArticle } from "@/lib/help/types";

const article: HelpArticle = {
  slug: "desktop-app-support",
  title: "Something's not syncing? Run the system check, then send a support bundle",
  summary: "Check the desktop app, copy redacted support info, and review a local bundle before sending it to support.",
  category: "desktop-app",
  audience: "all",
  order: 12,
  updated: "2026-11-02",
  keywords: ["support", "diagnostics", "system check", "bundle", "logs", "email", "missing replay", "copy support info"],
  body: [
    { type: "callout", tone: "info", title: "Desktop version availability", text: "These native Help tools are part of the next desktop release. They are not in the published 0.24.7 installer. Check [Desktop app updates](/help/desktop-app-updates) for availability; this article does not announce a new installer." },
    { type: "heading", text: "Run the system check", anchor: "system-check" },
    { type: "steps", items: [
      "In SC2 Tools, open **Help** or use **Help and troubleshooting** from the tray menu.",
      "Select **Run system check**. It checks the data folder, replay folders, analyzer and bundled sample replay, agent version, website, account link, StarCraft II client API, OBS when enabled, and current sync queues.",
      "Use **Retry**, **Open Settings** or **Link again** beside a row that needs attention. Retry runs another check. It does not re-sync your replay library, install an update or change OBS scenes.",
    ] },
    { type: "paragraph", text: "The check never launches StarCraft II or uploads a replay. Folder rows show counts and the newest replay time. A capped or incomplete scan says **at least** and reports the newest replay in the scanned sample. Missing or unreadable folders need attention; an unavailable check is not a passing check." },
    { type: "paragraph", text: "**Cancel** stops results being shown as soon as cancellation is received. A check already waiting on the operating system may need time to finish. While it is finishing, another support task cannot start. Leaving Help cancels its pending work." },
    { type: "heading", text: "Copy support info", anchor: "copy-info" },
    { type: "paragraph", text: "In SC2 Tools, open **Help > Copy support info** and paste it into your report. The same button is in the Activity log toolbar and tray menu. It works before a system check, with unmeasured checks marked unavailable." },
    { type: "paragraph", text: "The copied text includes the app and OS versions, update channel, API hostname, worker settings, folder and queue counts, sync range, recent classified error codes and available live counters. Account identity is limited to an eight-character user hash and, when the current connection validates it, the last six characters of the device ID. It does not include the device token, OBS password, player names, folder paths or raw exception messages." },
    { type: "heading", text: "Review and save a support bundle", anchor: "support-bundle" },
    { type: "steps", items: [
      "Select **Save support bundle…**. Wait for the reviewed file list.",
      "Review the generated filenames, byte sizes and omitted-line counts. The list contains diagnostics, a redacted state summary and selected parent/worker logs. Much free-form log text is deliberately omitted when it cannot be proven safe.",
      "Select **Save reviewed bundle…** and choose a new ZIP filename. Existing files are not overwritten. The saved archive contains exactly the reviewed bytes, even if the live logs changed after review.",
    ] },
    { type: "paragraph", text: "The bundle is local until you send it. It contains no replay/capture files, raw agent settings, credential-store files, environment dump or player-name cache. Input, line, log and entry limits can omit content; the reviewed list reports omissions and caps. If your linked account or connection changes, review a new bundle before saving." },
    { type: "heading", text: "Send your report", anchor: "send-report" },
    { type: "paragraph", text: "Select **Email support** to open a draft to [responsecoaching@gmail.com](mailto:responsecoaching@gmail.com), or use [Report a problem](/help/report-a-problem) on the website. Add what you clicked, what you expected and roughly when it happened. Attach the reviewed bundle yourself if it would help. Email is never sent automatically and no bundle is attached automatically." },
    { type: "paragraph", text: "Without the native window, the tray opens this guide. Copy support info uses the supported system clipboard; if it is unavailable, the app reports that it could not copy rather than printing private data to a console." },
  ],
  related: ["my-game-didnt-show-up", "desktop-app-sync-problems", "desktop-app-activity-log", "desktop-app-updates", "report-a-problem"],
};

export default article;
