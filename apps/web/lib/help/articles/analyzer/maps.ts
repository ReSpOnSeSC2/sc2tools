import type { HelpArticle } from "@/lib/help/types";

const article: HelpArticle = {
  slug: "maps",
  title: "Maps: your record on each map and matchup",
  summary:
    "Your win rate in each matchup and on each map, split by matchup, with your recent form, so you can see your strong and weak maps.",
  category: "analyzer",
  audience: "player",
  signedInOnly: true,
  order: 7,
  keywords: [
    "maps",
    "map stats",
    "map win rate",
    "matchups",
    "pvz",
    "tvz",
    "zvp",
    "map pool",
    "veto",
    "best map",
    "worst map",
    "recent form",
    "map preview",
  ],
  updated: "2026-10-23",
  body: [
    {
      type: "paragraph",
      text: "[Maps](/app/maps) answers: which matchups and maps go my way, and which ones don't. It counts the games the filter bar lets through, so set the date range to the current season to see this map pool.",
    },
    { type: "heading", text: "Matchups", anchor: "matchups" },
    {
      type: "paragraph",
      text: "One row per matchup, such as *vs Z*, with your wins, losses, games and win rate. The squares on the right are your last few results in that matchup, oldest to newest: green for a win, red for a loss.",
    },
    { type: "heading", text: "Win rate by map by matchup", anchor: "by-map" },
    {
      type: "list",
      items: [
        "One block per map with your overall record on it, then a row for each matchup you've played there.",
        "Sort the maps by **Win rate**, **Games**, **Wins** or **Losses**, and flip the direction with the button next to it.",
        "Click a map's picture for a larger view of the map.",
      ],
    },
    { type: "heading", text: "Using it to pick vetoes", anchor: "vetoes" },
    {
      type: "paragraph",
      text: "Sort by win rate and look at the bottom of the list for maps you could veto, but only trust a map with enough games behind it. A map you've played twice can sit at 0% or 100% by chance. Narrow the matchup in the filter bar to see your maps for one matchup only.",
    },
    { type: "heading", text: "How much data it needs", anchor: "sample-size" },
    {
      type: "list",
      items: [
        "**Min games** (3 by default) hides matchups and map rows with fewer games. A map shows when at least one of its matchups reaches it, and its overall record still counts every game on it.",
        "Win rates are colored from 3 games up; below that they stay grey.",
      ],
    },
    {
      type: "paragraph",
      text: "Everything here is counted from your replays with fixed rules, never AI. For one opponent's maps, open their [dossier](/help/opponent-dossier).",
    },
  ],
  related: ["trends", "reading-the-charts", "analyzer-filters", "opponent-dossier"],
};

export default article;
