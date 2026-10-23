import type { HelpArticle } from "@/lib/help/types";

const article: HelpArticle = {
  slug: "reading-the-charts",
  title: "Reading the charts: colors, sample sizes and Min games",
  summary:
    "How to read any table or chart in the analyzer: what the win-rate colors mean, how many games a number needs before you trust it, and what Min games does.",
  category: "analyzer",
  audience: "player",
  signedInOnly: true,
  order: 11,
  keywords: [
    "charts",
    "graphs",
    "colors",
    "colours",
    "green",
    "red",
    "grey",
    "win rate color",
    "sample size",
    "small sample",
    "not enough data",
    "min games",
    "minimum games",
    "50% line",
    "coin flip",
    "tooltip",
    "time zone",
    "no games match",
    "how are stats calculated",
    "ai",
  ],
  updated: "2026-10-23",
  body: [
    {
      type: "paragraph",
      text: "Every table and chart in the analyzer is counted from your own replays with fixed rules, never AI. The same games always give the same numbers, and a number you can click always lists the games behind it.",
    },
    { type: "heading", text: "Win-rate colors", anchor: "colors" },
    {
      type: "list",
      items: [
        "Win rates run from red (around 30% and below) through amber (around 50%) to green (around 65% and above).",
        "A win rate over fewer than 3 games stays **grey**, whatever it is: 1 win from 1 game isn't really 100%.",
        "In grids such as heatmaps, a fainter cell has fewer games behind it.",
      ],
    },
    { type: "heading", text: "How many games is enough?", anchor: "sample-size" },
    {
      type: "paragraph",
      text: "A win rate settles slowly. Over 5 games, one extra win moves it by 20 points; over 50 games, by 2. As a rule of thumb:",
    },
    {
      type: "table",
      head: ["Games", "How to read the win rate"],
      rows: [
        ["1 to 4", "A hint at most. Look at the games themselves."],
        ["5 to 19", "A direction. Compare it with something that has more games."],
        ["20 or more", "A result you can act on, especially when it stays the same over time."],
      ],
    },
    {
      type: "paragraph",
      text: "So always read the game count next to a percentage. Most rows show it, and most charts show it when you hover or tap a point.",
    },
    { type: "heading", text: "Min games", anchor: "min-games" },
    {
      type: "paragraph",
      text: "**Min games** hides rows with fewer games than the number you pick: 1, 3, 5, 10, 20 or your own number. It's on Opponents, Strategies, Maps and Builds, and each section remembers its own setting on this device. Raise it to see only results you can trust; set it to 1 to see everything. If that hides every row, the page says so and offers to lower it to 1.",
    },
    { type: "heading", text: "The 50% line and MMR charts", anchor: "mmr-charts" },
    {
      type: "list",
      items: [
        "A 50% line marks a coin flip. Above it you win more than you lose.",
        "Charts by MMR put games into MMR ranges and skip ranges with fewer games than Min games, so a line can have gaps.",
        "MMR comes from the replay itself, so unranked games and games without an MMR aren't on MMR charts.",
      ],
    },
    { type: "heading", text: "Dates and times", anchor: "dates" },
    {
      type: "paragraph",
      text: "Days, weeks and calendars use your computer's time zone, so a late-night session counts on the day you played it.",
    },
    { type: "heading", text: "Empty or missing", anchor: "empty" },
    {
      type: "list",
      items: [
        "*No games match these filters* means the filters really left nothing. Check the Active filters row under the filter bar; see [Filters](/help/analyzer-filters).",
        "*Not enough games yet* or *Not enough data* means there are games, just too few for that chart to say something fair.",
        "*Couldn't load* with a **Retry** button means the request failed, not that you have no data. See [Something went wrong](/help/something-went-wrong).",
      ],
    },
  ],
  related: ["analyzer-filters", "today", "opponents", "something-went-wrong"],
};

export default article;
