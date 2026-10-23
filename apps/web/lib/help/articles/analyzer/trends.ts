import type { HelpArticle } from "@/lib/help/types";

const article: HelpArticle = {
  slug: "trends",
  title: "Trends: how you're doing over time",
  summary:
    "Your win rate and MMR over time, matchup by matchup, when you play best, how game length changes results, and an explorer for your own questions.",
  category: "analyzer",
  audience: "player",
  signedInOnly: true,
  order: 5,
  keywords: [
    "trends",
    "win rate over time",
    "mmr progression",
    "mmr chart",
    "peak",
    "net mmr by matchup",
    "opponent mmr",
    "momentum",
    "session patterns",
    "time of day",
    "game length",
    "activity calendar",
    "map performance",
    "explore performance",
    "fingerprint",
    "day week month",
  ],
  updated: "2026-10-23",
  body: [
    {
      type: "paragraph",
      text: "[Trends](/app/trends) shows how your results move over time, for the games the filter bar lets through. It answers: am I improving, in which matchup, at what time of day do I play best, and do long games go my way.",
    },
    { type: "heading", text: "What's on the page", anchor: "charts" },
    {
      type: "table",
      head: ["Chart", "What it answers"],
      rows: [
        ["Games played, Win rate", "How much you play and how often you win, per day, week or month."],
        ["Win rate by matchup over time", "Which matchup is getting better or worse."],
        ["MMR progression", "Your rating game by game, with your peak and low marked, and your best and worst days."],
        ["Net MMR by matchup", "How much MMR each matchup has won or cost you. Click a bar to see the opponents behind it."],
        ["Win rate by opponent MMR", "How you do against weaker, equal and stronger players."],
        ["Session patterns", "Whether your results hold up through a long session."],
        ["Time played by matchup, Win rate by game length", "How long your games run, and whether short or long games go your way."],
        ["Activity by time of day, Activity calendar", "When you play, and when you play best."],
        ["Map performance over time", "Which maps are trending up or down for you."],
        ["Explore performance", "Ready-made analyses you pick from a list, such as comparing two periods, first meetings against rematches, or whether a worker or army lead at 5 minutes turns into wins. Press **Load analyses** to open it."],
        ["Fingerprint", "Your playstyle in each matchup, compared to common player archetypes."],
      ],
    },
    { type: "heading", text: "Drill in", anchor: "drill-in" },
    {
      type: "list",
      items: [
        "Use **Activity grouping** at the top to switch between **Day**, **Week** and **Month**. Days show detail; months smooth out the noise.",
        "Hover or tap a point to see its numbers. Where a chart offers it, click a bar or a cell to list the games behind it.",
        "Narrow the date range, matchup or region in the filter bar and every chart follows.",
      ],
    },
    { type: "heading", text: "How much data it needs", anchor: "sample-size" },
    {
      type: "list",
      items: [
        "A period with only a few games can swing from 0% to 100%. Look at the game count before reading much into one point.",
        "MMR charts use ranked 1v1 games with an MMR in the replay. Net MMR uses verified pairs: see [Net MMR and verified pairs](/help/opponents).",
        "Charts that need detailed replay measurements leave out games without them instead of guessing.",
      ],
    },
    {
      type: "paragraph",
      text: "Every chart is computed from your replays with fixed rules, never AI. New to reading these charts? See [Reading the charts](/help/reading-the-charts).",
    },
  ],
  related: ["reading-the-charts", "today", "opponents", "analyzer-filters"],
};

export default article;
