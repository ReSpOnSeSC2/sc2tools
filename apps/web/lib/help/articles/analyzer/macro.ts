import type { HelpArticle } from "@/lib/help/types";

const article: HelpArticle = {
  slug: "macro",
  title: "Macro: read your report and track progress",
  summary:
    "Track macro score, APM and spending quotient over time, read measured-game counts, compare a league median, and score older replays.",
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
    "mechanics progress",
    "apm",
    "hollow points",
    "league median",
  ],
  updated: "2026-10-25",
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
        ["Average macro score", "Your average score, scored-game coverage and the action to score older games."],
        ["Mechanics progress", "Average macro score, APM or SQ per calendar period, with each metric's own measured-game count."],
        ["Fix this first", "The single leak that costs you the most, how often it happens, about how many minerals it costs per game, and whether it's getting better."],
        ["Does macro win you games?", "Your recorded win rate for each band of macro score. It describes the games in that band; it does not establish what caused their results."],
        ["Where macro collapses", "Your average score and win rate by matchup, game length and build, so you can see where your macro slips."],
        ["Leak ledger", "Every leak priced in minerals, with your win rate in games with and without it."],
      ],
    },
    {
      type: "paragraph",
      text: "Click any row or band to see the games behind it, then open one to see that game's own macro breakdown.",
    },
    { type: "heading", text: "Track mechanics progress", anchor: "progress" },
    {
      type: "list",
      items: [
        "Switch between **Macro score**, **APM** (recorded actions per minute) and **SQ** (spending quotient). More actions alone do not establish better play. SQ measures spending in relation to income and is separate from the macro score.",
        "**Group by** uses calendar days, weeks or months and shares your grouping preference with Trends and Build mix. The server can return a coarser interval for a long history; the chart names the interval actually returned.",
        "The horizontal spacing follows real calendar dates. Missing periods and missing measurements break the line instead of becoming zero. Each average includes only games measured for that metric; APM and macro score can have different counts.",
        "Hollow points have fewer than five measured games, or a count unavailable in an older response. Use **Inspect period** to read the value and measured-game count without hovering. Five games is a reading cue, not a guarantee of improvement.",
        "For an optional **League reference**, choose ranked 1v1, one own race and one opponent race in the shared filters, then select a league. The dashed line is that matchup's measured league median, shown only with at least 50 measurements. It compares a population median with your period averages and is not a personal target. Missing or mismatched tables leave the line out.",
      ],
    },
    { type: "heading", text: "Score your older games", anchor: "backfill" },
    {
      type: "paragraph",
      text: "Games synced before macro scoring existed have no score. When some are missing, **Score N older games** asks your desktop app to read those replays again. If there are no scores yet, **Score my older games** is available when your paired app is online; otherwise **Get the desktop app** opens setup. The app must stay running with the original replays on your PC. Progress appears on the page, and the scores fill in as each game completes.",
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
