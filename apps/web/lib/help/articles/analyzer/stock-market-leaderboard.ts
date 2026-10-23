import type { HelpArticle } from "@/lib/help/types";

const article: HelpArticle = {
  slug: "stock-market-leaderboard", title: "Stock Market leaderboard", category: "analyzer", audience: "player", signedInOnly: true, updated: "2026-10-23", related: ["arcade"],
  summary: "Opt into the weekly board, browse settled weeks and find your own rank without exposing your portfolio.", keywords: ["stock market", "leaderboard", "rank", "weekly", "portfolio", "settled"],
  body: [
    { type: "steps", items: ["Open [Arcade](/app/arcade), choose the Stock Market and pick your portfolio.", "Opt into the leaderboard when you lock it. Choose a display name or leave it empty for an **Anonymous N** handle. Portfolios stay private.", "Open the [Stock Market leaderboard](/community/leaderboard) while signed in. Use **Prev week**, **Next week** or **This week** to browse. The week in the URL can be shared."] },
    { type: "heading", text: "When results appear", anchor: "results" },
    { type: "paragraph", text: "The board opens on the previous week by default. Current-week rows show **Locked**: results settle after the week ends, when each player next opens the Stock Market. A past-week row without a result shows **Awaiting result**, below the settled players and without a rank." },
    { type: "heading", text: "Your rank", anchor: "your-rank" },
    { type: "paragraph", text: "The **Your rank** strip shows your own result even when you are outside the first 50 players. That strip is visible only to you. Your row is marked **You**; choose **Show more** to see up to 200 rows. If you have not opted into that week, the strip links back to the Stock Market." },
    { type: "paragraph", text: "The board is visible only to signed-in players because it shows player names. Other players can see your leaderboard name or anonymous handle, weekly percentage and rank, never your portfolio picks." },
  ],
};
export default article;
