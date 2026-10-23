import type { HelpArticle } from "@/lib/help/types";

const article: HelpArticle = {
  slug: "notifications", title: "Notifications", summary: "Find reviews, coaching updates, import results and replies to your reports. Choose which updates you receive.",
  category: "account-data", audience: "all", signedInOnly: true, order: 25, updated: "2026-10-23",
  keywords: ["bell", "inbox", "notifications", "mute", "unread", "mark all read", "import finished", "report reply"],
  body: [
    { type: "paragraph", text: "The bell is available whenever you are signed in. Open [Notifications](/notifications) for the full inbox. Broadcast overlays and the Stream Dock do not show your personal notifications." },
    { type: "heading", text: "What appears here", anchor: "kinds" },
    { type: "list", items: ["**Reviews:** new reviews, replies, helpful and best-answer marks, and the review digest when Reviews are available.", "**Coaching:** session bookings and cancellations, practice assignments, and practice-sharing requests and decisions.", "**System:** finished desktop imports, required desktop app updates, community build upvotes, and status changes or replies to your reports."] },
    { type: "heading", text: "Read and filter your inbox", anchor: "read-and-filter" },
    { type: "list", items: ["Opening the bell marks the visible rows as read. Rows that were new stay tinted and show **New** until you close it.", "Switch between **Unread** and **All notifications**, then use **Reviews**, **Coaching** or **System** to narrow the loaded rows. **Load more notifications** brings in older rows.", "**Mark all read** clears the unread badge for your whole inbox, including rows not loaded yet. **See all notifications** opens the full page, with kind filters and Previous / Next pages.", "If the bell cannot load, it stays visible and offers **Retry**. You can close it with Escape or by clicking outside it."] },
    { type: "heading", text: "Mute a kind of update", anchor: "muting" },
    { type: "paragraph", text: "Open [Settings → Misc](/settings?tab=misc), find **Notifications**, untick the kinds you do not want, and press **Save notification preferences**. Muting skips future notifications of that kind. It does not remove older rows, change your coaching schedule, or turn off the build check-in queue." },
    { type: "heading", text: "Reports and retention", anchor: "retention" },
    { type: "paragraph", text: "Notifications are retained for up to **90 days**. For the latest 20 reports you sent and their replies, open [Settings → Help → My reports](/settings?tab=help#my-reports). See [Report a problem or suggest a feature](/help/report-a-problem) for the full support flow." },
  ], related: ["report-a-problem", "desktop-app-overview", "build-check-in"],
};
export default article;
