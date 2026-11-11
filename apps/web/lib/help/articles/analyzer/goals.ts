import type { HelpArticle } from "@/lib/help/types";

const article: HelpArticle = {
  slug: "goals",
  title: "Goals: set a target and track it automatically",
  summary: "Set goals for games played, win rate, MMR, macro score, SQ, APM or build practice; progress fills in from your replays and you get one notification when you reach one.",
  category: "analyzer",
  audience: "player",
  signedInOnly: true,
  order: 12,
  related: ["today", "league-targets", "macro"],
  keywords: ["goal", "goals", "target", "practice", "win rate goal", "mmr goal", "weekly", "streak", "pin", "notification"],
  updated: "2026-11-10",
  body: [
    { type: "paragraph", text: "Open [Goals](/app/goals) from the navigation and choose **New goal**. A template sets the kind of goal; then pick the target, the matchup, the map, whether only ranked 1v1 games count, and when it runs. Progress is computed from your own uploaded games with fixed rules, never AI, so there is nothing to log by hand." },
    { type: "heading", text: "Kinds of goal", anchor: "types" },
    { type: "table", head: ["Goal", "What it measures", "Counts from"], rows: [
      ["Play more games", "Games played in the period", "The first game"],
      ["Win rate", "Wins ÷ (wins + losses); ties and unknown results are left out", "20 decided games, or more if you choose"],
      ["Reach an MMR", "Your peak replay-recorded rating in the window; the bar runs from your first rating in the window to the target", "Your first rated game"],
      ["Macro score, SQ, APM", "The average over games that measured it", "10 games by default, at least 5"],
      ["Practise a build", "Games played with that build", "The first game"],
    ] },
    { type: "heading", text: "Windows and how they reset", anchor: "windows" },
    { type: "paragraph", text: "Every day, week or month goal resets in your own timezone: daily at local midnight, weekly on Monday, monthly on the 1st, including across daylight-saving changes. The From and Until dates bound the whole goal; a new weekly goal starts on this week's Monday so the current week counts in full. **One window** runs once between the two dates, and **One ladder season** uses the season you pick. A game belongs to the period in which it ended." },
    { type: "heading", text: "Minimum games", anchor: "min-games" },
    { type: "paragraph", text: "A rate from a handful of games swings wildly, so a win rate or an average is not shown as a number until it has its minimum sample. Until then the bar fills toward that sample and says, for example, \"9 more games before this rate counts\". An MMR goal says \"No rated games yet\" until a game in the window carries a rating." },
    { type: "heading", text: "What counts", anchor: "what-counts" },
    { type: "list", items: [
      "Your own games in the window that match the goal's matchup and map; ranked 1v1 only unless you turn that off.",
      "Hidden, deleted and resumed-from-replay games never count.",
      "For a build goal, a game you checked in to that build counts even when the replay was classified as something else; the progress line says how many came from check-ins.",
      "**See these games** opens the matching analyzer section with the same filters and the current period's dates.",
    ] },
    { type: "heading", text: "Today, limits and notifications", anchor: "today" },
    { type: "paragraph", text: "You can have up to 8 active goals. Pin up to 3 to show their bars on [Today](/app). When a goal's period is reached you get one in-app notification for that period; a one-window or season goal then moves to Completed, and a goal whose dates have passed moves there as Reached or Ended. Turn the notification off under **Goals reached** in [notification settings](/settings?tab=misc)." },
  ],
};

export default article;
