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
  ],
};

export default article;
