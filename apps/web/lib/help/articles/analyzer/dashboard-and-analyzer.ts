import type { HelpArticle } from "@/lib/help/types";

const article: HelpArticle = {
  slug: "dashboard-and-analyzer",
  title: "Dashboard & analyzer",
  summary:
    "What the analyzer shows from your replays, section by section: Today, Opponents, Strategies, Trends, Macro, Maps, Build stats, Replays and Arcade.",
  category: "analyzer",
  audience: "player",
  order: 0,
  keywords: [
    "stats",
    "dashboard",
    "analyzer",
    "sections",
    "win rate",
    "mmr",
    "maps",
    "opponents",
    "scouting",
    "head-to-head",
    "strategy detection",
    "opener",
    "custom builds",
    "how to read this",
    "today",
    "session",
    "games today",
    "record",
    "default tab",
    "retry",
  ],
  updated: "2026-10-23",
  body: [
    { type: "heading", text: "Getting around", anchor: "getting-around" },
    { type: "paragraph", text: "Pin the sidebar with the button at its bottom to keep its labels visible and push content beside it. **Analysis** holds your stats sections, including **Build stats**. **Your setup** holds **Build library**, Community, Stream Studio, Devices and Settings. On phones, **More** holds everything else, **Help & support**, **Install app** when supported and the Light/Dark theme switch." },
    {
      type: "paragraph",
      text: "Everything in the analyzer comes from your own replays, with no manual tagging. Each replay is read with fixed rules, never AI: the opening you and your opponent played is named from more than 100 known builds, and your record, MMR, macro and timings are counted from the replay itself. The same games always give the same numbers.",
    },
    { type: "heading", text: "The sections", anchor: "sections" },
    {
      type: "table",
      head: ["Section", "What it answers"],
      rows: [
        ["[Today](/help/today)", "How is today going, and what did my last game tell me?"],
        ["[Opponents](/help/opponents)", "Who do I play, who beats me, and who costs me MMR?"],
        ["[Strategies](/help/strategies)", "Which openings beat me, and which of my builds answers each one?"],
        ["[Trends](/help/trends)", "Am I improving, in which matchup, and when do I play best?"],
        ["[Macro](/help/macro)", "Which macro mistake costs me the most, and does fixing it win games?"],
        ["[Maps](/help/maps)", "Which maps and matchups go my way?"],
        ["[Build stats](/help/builds)", "How does each of my builds perform, and am I getting better with it?"],
        ["[Replays](/help/replays)", "Where is that game I want to review?"],
        ["[Arcade](/help/arcade)", "What don't I know about my own play?"],
      ],
    },
    {
      type: "paragraph",
      text: "Analyzer sections have a **How to read this** link next to their title that opens the relevant article. The filter bar controls filtered sections; Today has cards with their own scope, while Arcade and individual game pages ignore it. See [Filters](/help/analyzer-filters) for the full scope and [Today](/help/today) for the session cards, Retry and Default tab. For colors, sample sizes and Min games, see [Reading the charts](/help/reading-the-charts).",
    },
  ],
  related: ["today", "analyzer-filters", "reading-the-charts", "getting-started"],
};

export default article;
