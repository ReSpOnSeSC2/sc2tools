import type { HelpArticle } from "@/lib/help/types";

const article: HelpArticle = {
  slug: "macro",
  title: "Macro: read your report and track progress",
  summary:
    "What the macro score measures, which leak costs you the most, whether better macro wins you games, and how to score your older replays.",
  category: "analyzer",
  audience: "player",
  signedInOnly: true,
  order: 6,
  keywords: [
    "macro",
    "macro score",
    "spending quotient",
    "sq",
    "leaks",
    "leak ledger",
    "supply blocked",
    "floating minerals",
    "injects",
    "chrono",
    "mules",
    "fix this first",
    "does macro win you games",
    "where macro collapses",
    "score older games",
    "backfill",
  ],
  updated: "2026-10-23",
  body: [
    {
      type: "paragraph",
      text: "[Macro](/app/macro) looks at your economy across all the games the filter bar lets through. It answers: how clean is my macro, which mistake costs me the most, and does fixing it actually win games.",
    },
    { type: "heading", text: "The macro score", anchor: "macro-score" },
    {
      type: "paragraph",
      text: "Every synced game gets a macro score from 0 to 100. It starts from your **spending quotient** (SQ), a standard measure of how well you keep your money spent as your income grows, then takes points off for time spent supply blocked, for missed race mechanics (injects, Chrono Boost or MULEs) and for floating resources. Roughly: 75 and up is strong, 50 to 74 is decent, under 50 leaves a lot on the table.",
    },
    { type: "heading", text: "What's on the page", anchor: "cards" },
    {
      type: "table",
      head: ["Card", "What it tells you"],
      rows: [
        ["Average macro score", "Your average score, how many of your games are scored, and your most expensive recurring leaks."],
        ["Fix this first", "The single leak that costs you the most, how often it happens, about how many minerals it costs per game, and whether it's getting better."],
        ["Does macro win you games?", "Your win rate for each band of macro score. A rising line means better macro is paying off."],
        ["Where macro collapses", "Your average score and win rate by matchup, game length and build, so you can see where your macro slips."],
        ["Leak ledger", "Every leak priced in minerals, with your win rate in games with and without it."],
      ],
    },
    {
      type: "paragraph",
      text: "Click any row or band to see the games behind it, then open one to see that game's own macro breakdown.",
    },
    { type: "heading", text: "Score your older games", anchor: "backfill" },
    {
      type: "paragraph",
      text: "Games synced before macro scoring existed have no score. When some are missing, a **Score N older games** button appears at the top. It asks the desktop app on your PC to read those replays again, so the app has to be running and the replays still on your PC. The scores fill in as each game is done.",
    },
    { type: "heading", text: "How much data it needs", anchor: "sample-size" },
    {
      type: "list",
      items: [
        "One game's score tells you about that game. Your average and the leak ledger start to mean something after 10 or more scored games.",
        "*Fix this first* compares your recent scored games with the ones before, so its trend needs a steady stream of new games.",
        "A band or segment with only a few games can show an extreme win rate. Check its game count before acting on it.",
      ],
    },
    {
      type: "paragraph",
      text: "The score and every leak are computed from your replays with fixed rules, never AI.",
    },
  ],
  related: ["game-page", "trends", "reading-the-charts", "analyzer-filters"],
};

export default article;
