import type { HelpArticle } from "@/lib/help/types";

const article: HelpArticle = {
  slug: "arcade",
  title: "Arcade: quizzes and games about your own play",
  summary:
    "Daily quizzes and games built from your real replays, your Season Recap, a card collection of your builds and the Stock Market, with XP, streaks and badges.",
  category: "analyzer",
  audience: "player",
  signedInOnly: true,
  order: 10,
  keywords: [
    "arcade",
    "quiz",
    "quizzes",
    "games",
    "daily drop",
    "daily run",
    "daily quests",
    "quick play",
    "collection",
    "card binder",
    "my stats",
    "xp",
    "level",
    "minerals",
    "badges",
    "streak",
    "season recap",
    "stock market",
    "bingo",
    "buildle",
  ],
  updated: "2026-10-23",
  body: [
    {
      type: "paragraph",
      text: "[Arcade](/app/arcade) turns your own games into short quizzes and games. Every question is built from your real replays, so answering it teaches you something true about how you play, often something no single chart shows: which rival is on a streak against you, how you do after three losses in a row, which build wins fastest.",
    },
    { type: "heading", text: "The four tabs", anchor: "tabs" },
    {
      type: "table",
      head: ["Tab", "What's there"],
      rows: [
        ["Today", "**Daily Quests**, the **Daily Drop** (one quiz) and the **Daily Run** (one game). They change every day at midnight."],
        ["Quick Play", "Every quiz and game, to play any time. Filter by **Quizzes** or **Games** and by how long they take."],
        ["Collection", "Your **Card binder**, with a card for every build you've played, and the **Cosmetics shop**."],
        ["My Stats", "Your streak, level, accuracy and minerals, and your record in each mode."],
      ],
    },
    { type: "heading", text: "Season Recap", anchor: "season-recap" },
    {
      type: "paragraph",
      text: "At the top of Arcade, **Season Recap** sums up your season as a set of slides you can share as an image. It unlocks once you have 10 games.",
    },
    { type: "heading", text: "XP, minerals and badges", anchor: "progress" },
    {
      type: "list",
      items: [
        "Answering and playing earns XP, which raises your level, and minerals to spend in the Cosmetics shop.",
        "Playing every day keeps your streak going. Badges reward runs of correct answers and perfect days.",
        "Your Arcade progress is saved to your account, so it follows you to every device.",
      ],
    },
    { type: "heading", text: "Stock Market", anchor: "stock-market" },
    {
      type: "paragraph",
      text: "Spread 100 points across up to five of your builds for the week. Your return depends on how those builds actually do in your games that week. You can show your result on the weekly leaderboard in [Community](/community/leaderboard), or keep it to yourself.",
    },
    { type: "heading", text: "How much data it needs", anchor: "sample-size" },
    {
      type: "list",
      items: [
        "Each mode needs enough of the right games to ask a fair question, such as at least 3 opponents to compare. When it can't, it says what's missing instead of making up an answer.",
        "With only a few games, some days have no Daily Drop or Daily Run. They appear as you play more.",
      ],
    },
    {
      type: "paragraph",
      text: "Every question and answer is computed from your replays with fixed rules, never AI.",
    },
  ],
  related: ["today", "builds", "opponents", "trends"],
};

export default article;
