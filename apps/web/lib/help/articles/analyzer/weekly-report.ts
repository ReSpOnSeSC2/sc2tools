import type { HelpArticle } from "@/lib/help/types";

const article: HelpArticle = {
  slug: "weekly-report", title: "Weekly report",
  summary: "Every Monday morning, a short summary of last week's games next to the week before: record by matchup, MMR, best and worst map and build, opponents and macro.",
  category: "analyzer", audience: "player", signedInOnly: true, order: 40, updated: "2026-11-10",
  keywords: ["weekly report", "week summary", "monday", "weekly recap", "last week", "time zone", "report settings"],
  body: [
    { type: "paragraph", text: "The weekly report arrives in your notifications on Monday around 09:00 in your report time zone. Open it, or go straight to [last week's report](/app/reports/weekly/latest). Use **Previous week** and **Next week** to move between weeks, and **Open in Trends** to explore the same dates with every chart." },
    { type: "heading", text: "What it shows", anchor: "what-it-shows" },
    { type: "list", items: [
      "**Games, record, time played and sessions**, each next to the week before.",
      "**Matchups:** win rate and record for each matchup this week, with last week's record and game count beside it.",
      "**MMR:** start, end, change and peak for each account and race you played rated games on.",
      "**Best and worst map and build:** only maps and builds with at least three decided games count, and the record is always shown.",
      "**Opponent strategies you faced most:** the top three, with your record against each.",
      "**Macro:** your average macro score and most frequent leak next to the week before, once at least three games have them.",
    ] },
    { type: "paragraph", text: "Every number comes from your uploaded replays and fixed rules, never AI. The report states what happened; it does not guess why." },
    { type: "heading", text: "Turn it on or off", anchor: "settings" },
    { type: "paragraph", text: "Open [Settings → Preferences → Reports](/settings?tab=preferences#reports). **Weekly report** controls the Monday notification. **Use this device's time zone** sets when your weeks start and end; until you save one, weeks follow UTC. Weeks with fewer than five games are skipped. You can still open any week's report from the page itself." },
    { type: "callout", tone: "info", title: "On your phone or Discord", text: "Turn on [phone and browser notifications](/help/notifications-on-your-phone) to get the report away from the site, or post a weekly recap to a channel with [Post your games to Discord](/help/discord)." },
  ],
  related: ["stream-reports", "notifications", "notifications-on-your-phone", "discord"],
};
export default article;
