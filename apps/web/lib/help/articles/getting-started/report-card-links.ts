import type { HelpArticle } from "@/lib/help/types";

const article: HelpArticle = {
  slug: "report-card-links",
  title: "Share a browser replay report by link",
  summary: "Copy a replay report card link with only the aggregate rows you choose.",
  category: "getting-started",
  audience: "all",
  order: 9,
  updated: "2026-11-11",
  keywords: ["replays", "report", "share card", "link", "browser"],
  related: ["instant-analysis", "browser-import"],
  body: [
    { type: "steps", items: [
      "Open your report in the [browser replay analyzer](/try) and choose **Share your report**.",
      "Select the rows you want to share, then choose **Copy card link**. If your browser blocks clipboard access, copy the selected link manually.",
      "Send the complete link, including the part after `#`. Recipients can see the card without an account.",
    ] },
    { type: "heading", text: "What the link contains", anchor: "privacy" },
    { type: "paragraph", text: "The link contains selected counts, matchup races, a catalog opener and macro score. It excludes player names, account IDs, individual games and replay files. The recipient's browser redraws the card. The numbers are self-reported and anyone with the link can view them." },
    { type: "heading", text: "Compare two reports", anchor: "compare" },
    { type: "paragraph", text: "Open the shared card and paste your own report card link under **Compare with your report**. Select Totals when making your card link. The comparison shows the games, record and win rate for each person's selected games." },
    { type: "paragraph", text: "Choose **Copy comparison link** to send the two records back. The link contains only the two sets of counts. Link previews show the card class, and the selected results appear when the recipient opens the link." },
  ],
};

export default article;
