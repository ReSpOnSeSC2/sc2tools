import type { HelpArticle } from "@/lib/help/types";

const article: HelpArticle = {
  slug: "notifications", title: "Notifications", summary: "Find reviews, coaching updates, ladder milestones, import results and replies to your reports. Choose which updates you receive.",
  category: "account-data", audience: "all", signedInOnly: true, order: 25, updated: "2026-11-12",
  keywords: ["bell", "inbox", "notifications", "milestones", "mute", "unread", "mark all read", "import finished", "report reply"],
  body: [
    { type: "paragraph", text: "The bell is available whenever you are signed in. Open [Notifications](/notifications) for the full inbox. Broadcast overlays and the Stream Dock do not show your personal notifications." },
    { type: "heading", text: "What appears here", anchor: "kinds" },
    { type: "list", items: ["**Reviews:** new reviews, replies, helpful and best-answer marks, and the review digest when Reviews are available.", "**Coaching:** session bookings and cancellations, reminders 24 hours and 1 hour before a session, practice assignments, and practice-sharing requests and decisions.", "**Milestones:** recorded MMR marks, season peaks, win streaks, broken loss streaks, revenge wins, giant-killer wins and marathon wins. Open a milestone to see its game.", "**System:** your [weekly report](/help/weekly-report) and [stream reports](/help/stream-reports), finished desktop imports, required desktop app updates, a [Discord channel](/help/discord) that stopped posting, community build upvotes, and status changes or replies to your reports."] },
    { type: "paragraph", text: "See [Notifications on your phone](/help/notifications-on-your-phone) for updates available when SC2 Tools is closed." },
    { type: "heading", text: "Read and filter your inbox", anchor: "read-and-filter" },
    { type: "list", items: ["Opening the bell marks the visible rows as read. Rows that were new stay tinted and show **New** until you close it.", "Switch between **Unread** and **All notifications**, then use **Reviews**, **Coaching**, **Milestones** or **System** to narrow the loaded rows. **Load more notifications** brings in older rows.", "**Mark all read** clears the unread badge for your whole inbox, including rows not loaded yet. **See all notifications** opens the full page, with kind filters and Previous / Next pages.", "If the bell cannot load, it stays visible and offers **Retry**. You can close it with Escape or by clicking outside it. Escape returns to the bell; clicking another control keeps focus on that control. Tab can leave the panel, and the page stays scrollable."] },
    { type: "heading", text: "Choose which updates you receive", anchor: "muting" },
    { type: "paragraph", text: "Open [Settings → Preferences](/settings?tab=preferences#notifications) and find **Notifications**. Check **Milestones** to get private bell updates from newly synced ladder games. Clear a checked box to stop future updates of that kind, then select **Save notifications**. Your existing rows remain in your inbox." },
    { type: "heading", text: "Reports and retention", anchor: "retention" },
    { type: "paragraph", text: "Notifications are retained for up to **90 days**. For the latest 20 reports you sent and their replies, open [Settings → Help → My reports](/settings?tab=help#my-reports). See [Report a problem or suggest a feature](/help/report-a-problem) for the full support flow." },
  ], related: ["report-a-problem", "notifications-on-your-phone", "weekly-report", "desktop-app-overview", "build-check-in"],
};
export default article;
