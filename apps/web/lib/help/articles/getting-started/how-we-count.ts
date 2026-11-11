import type { HelpArticle } from "@/lib/help/types";

const article: HelpArticle = {
  slug: "how-we-count",
  title: "How we count the landing page totals",
  summary: "See where the live ladder numbers come from and how often they refresh.",
  category: "getting-started", audience: "all", order: 6, updated: "2026-11-11",
  keywords: ["ladder totals", "games analyzed", "community builds", "answered reviews", "guide corpus"],
  body: [
    { type: "paragraph", text: "The landing page rounds totals down and shows them only after they reach a minimum. A source can be temporarily unavailable, so you may see some totals without the others." },
    { type: "list", items: [
      "**Games analyzed** is an estimate of game records stored by SC2 Tools. Games analyzed only on your device are outside this total.",
      "**Published Community builds** counts current public listings.",
      "**Answered replay reviews** counts listed requests with an accepted best answer.",
      "**Games in the guide corpus** counts eligible ladder game records used by the last completed guide stats run after the per-player sample limits. It covers the current and archived starting-worker eras.",
    ] },
    { type: "paragraph", text: "Totals refresh about once an hour. Climbing this week compares published guide win rates with the previous week's sample. Fresh from the community ranks builds published in the past seven days by votes." },
  ],
  related: ["build-guides", "replay-reviews"],
};

export default article;
