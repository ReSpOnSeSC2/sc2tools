import type { HelpArticle } from "@/lib/help/types";

const article: HelpArticle = {
  slug: "reading-the-charts",
  title: "Reading the charts: colors, sample sizes and Min games",
  summary:
    "How to read analyzer charts: win-rate colors, sample sizes, data tables and the Min games filter.",
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
  updated: "2026-10-25",
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
        "On MMR, macro and head-to-head comparison charts, **hollow or dim marks** flag fewer than 20 decided results. The actual percentage and record remain available; a 1–0 record is still shown as 100% with a small-sample cue.",
        "Some compact summary tables keep their existing grey cue below 3 games. In heatmaps, background strength shows sample size while labels remain readable.",
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
        ["20 or more", "More evidence, with opponents, maps and game length still able to differ. This is a reading aid, not a guarantee."],
      ],
    },
    {
      type: "paragraph",
      text: "Read the count next to a percentage. A decided result is a win or loss; other outcomes remain visible in the total. Mechanics averages use the number of measured games instead, and missing counts get a hollow cue.",
    },
    { type: "heading", text: "Min games", anchor: "min-games" },
    {
      type: "paragraph",
      text: "**Min games** hides rows with fewer games than the number you pick: 1, 3, 5, 10, 20 or your own number. It's on Opponents, Strategies, Maps and Builds, and each section remembers its own setting on this device. Raise it to compare larger samples; set it to 1 to see every recorded group. If that hides every row, the page says so and offers to lower it to 1.",
    },
    { type: "heading", text: "The 50% line and MMR charts", anchor: "mmr-charts" },
    {
      type: "list",
      items: [
        "A 50% line marks a coin flip. Above it you win more than you lose.",
        "MMR bands are separate comparison rows on one percentage scale. Rates below the selected minimum are withheld with their counts still visible; no line connects unrelated bands.",
        "MMR progression and build curves keep their actual time or play-count order. Separate accounts and ladder races keep separate labeled series.",
        "MMR comes from the replay itself, so unranked games and games without an MMR aren't on MMR charts.",
      ],
    },
    { type: "heading", text: "View as table", anchor: "view-as-table" },
    { type: "paragraph", text: "Where shown, choose **View as table** to read the same filtered values and counts without hovering. **Show chart** returns to the visual. The table scrolls inside its own focusable area on a narrow screen, and existing game links or drilldown actions remain available." },
    { type: "paragraph", text: "Series have visible names and, when colors repeat, dash patterns. Recent-form results also have shapes or W/L labels. Charts honor your device's reduced-motion preference; no color or animation is required to read the table." },
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
