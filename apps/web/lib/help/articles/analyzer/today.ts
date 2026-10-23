import type { HelpArticle } from "@/lib/help/types";

const article: HelpArticle = {
  slug: "today",
  title: "Today: your between-games view",
  summary:
    "What Today shows: the game you're playing, today's games, your streak and MMR, the Daily Pulse insights and the Ladder Pulse briefing on your latest replay.",
  category: "analyzer",
  audience: "player",
  signedInOnly: true,
  order: 1,
  keywords: [
    "today",
    "dashboard",
    "home",
    "kpi",
    "games today",
    "win rate",
    "active streak",
    "games in range",
    "mmr",
    "live game",
    "daily pulse",
    "ladder pulse",
    "daily replay",
    "recent form",
    "default tab",
    "session",
    "retry",
  ],
  updated: "2026-10-23",
  body: [
    {
      type: "paragraph",
      text: "[Today](/app?view=today) answers the questions you have between games: how is today going, am I on a streak, where is my MMR, and what did the last game tell me. The game cards update as each replay syncs, without a refresh.",
    },
    { type: "heading", text: "The live game", anchor: "live-game" },
    {
      type: "paragraph",
      text: "While you're in a game, a card at the top shows the matchup, your opponent and the game clock. It comes from the desktop app on your gaming PC, so it only appears while the app is running, and it goes away when you're back in the menus.",
    },
    { type: "heading", text: "The cards", anchor: "cards" },
    {
      type: "table",
      head: ["Card", "What it counts"],
      rows: [
        ["Today's session", "Today's games and win-loss record, by your own clock, for example **6 games · 4W 2L**."],
        ["Win rate", "Your win rate over the timeframe picked in the menu next to its title. It has its own timeframe and ignores the date range in the filter bar."],
        ["Active streak", "Your current run of wins or losses, from your latest games."],
        ["Games in range", "Every game the filter bar lets through. Its note says which filters apply."],
        ["MMR", "Your current ladder rating from SC2Pulse, for the Pulse IDs in [Settings → Profile](/settings?tab=profile#pulse-id-help). With none saved, the card links there to add one. It ignores filters."],
      ],
    },
    {
      type: "paragraph",
      text: "Exactly which filters each card follows is in [Filters: date, matchup, region and more](/help/analyzer-filters).",
    },
    {
      type: "paragraph",
      text: "A card that couldn't load shows **—** and *Couldn't load · Retry*. Press **Retry** to load that card again; the rest of the page keeps working. A real zero still shows 0.",
    },
    { type: "heading", text: "Daily Pulse", anchor: "daily-pulse" },
    {
      type: "paragraph",
      text: "A strip of short insights picked from your own games, with a fresh mix every day: yesterday's session, a streak, how close you are to your MMR peak, a build on the rise, a nemesis, a map edge, a milestone. Open a card to jump to the section with the full story. Press the strip's header to open or close it; the choice is remembered on this device.",
    },
    { type: "heading", text: "Ladder Pulse", anchor: "ladder-pulse" },
    {
      type: "list",
      items: [
        "**Your latest replay:** your opener, what the opponent showed, the MMR change, the macro score and your last few results. Click through to the game page.",
        "**Daily replay:** one of your games picked for review each day, the same game all day.",
        "**Recent form:** how your latest games went in the matchup or with the build you just played.",
        "**Across SC2 Tools:** how often the opener you just faced is being played on the ladder right now.",
      ],
    },
    { type: "heading", text: "How much data it needs", anchor: "sample-size" },
    {
      type: "list",
      items: [
        "The cards work from your first game. A win rate over a handful of games swings a lot, so read it together with the number of games.",
        "Daily Pulse only shows a card when your games support it. With few games, some days have fewer cards.",
        "Ladder Pulse needs at least one synced replay. Its MMR change needs two ranked games in a row on the same account and race.",
      ],
    },
    {
      type: "callout",
      tone: "info",
      title: "Where the numbers come from",
      text: "Every number here is computed from your replays with fixed rules, never AI. The same games always give the same numbers.",
    },
    {
      type: "paragraph",
      text: "Prefer to land on another section? Pick it under **Default tab** in [Settings → Misc](/settings?tab=misc). It applies when you first open the dashboard in a browser session. Clicking **Today** or its app shortcut always opens Today.",
    },
  ],
  related: ["analyzer-filters", "dashboard-and-analyzer", "reading-the-charts", "game-page"],
};

export default article;
