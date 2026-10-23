import type { HelpArticle } from "@/lib/help/types";

const article: HelpArticle = {
  slug: "game-page",
  title: "The game page: one game in detail",
  summary:
    "Everything about one game: the build orders, the timeline, the map replay, your mechanics, why you lost, and the buttons to download, share, check in or save the build.",
  category: "game-page",
  audience: "player",
  signedInOnly: true,
  order: 1,
  keywords: [
    "game page",
    "game detail",
    "replay analysis",
    "build order",
    "build orders",
    "timeline",
    "army value",
    "mechanics",
    "macro score",
    "sq",
    "apm",
    "why you lost",
    "loss autopsy",
    "save as new build",
    "share this game",
    "battle card",
    "download replay",
    "ask for a review",
  ],
  updated: "2026-10-23",
  body: [
    {
      type: "paragraph",
      text: "Click any game, in [Replays](/app/replays), in an opponent's dossier or on [Today](/app), to open its game page. It shows that one game and ignores the filter bar.",
    },
    { type: "heading", text: "The header", anchor: "header" },
    {
      type: "list",
      items: [
        "The result, matchup and map, when it was played, how long it lasted, the MMR, and your opponent, with a link to their dossier.",
        "**My build** and **Opponent strategy** name the openings the replay shows. **Planned** or **Corrected** means you changed them with [Build check-in](/help/build-check-in).",
        "**Share this game** saves or shares the game as an image. The download button gets the original .SC2Replay file, and **Ask for a review** asks other players about a moment in the game.",
        "When you or your opponent streamed the game, a link jumps to that moment in the recording.",
      ],
    },
    { type: "heading", text: "Down the page", anchor: "cards" },
    {
      type: "table",
      head: ["Card", "What it shows"],
      rows: [
        ["Build check-in", "Which build you were going for, and the opponent's build if the replay named it wrong."],
        ["Game timeline", "Both armies, your unspent minerals and your supply over the game, with fights marked along the bottom. Click the chart or a fight, or drag the slider, to read the numbers at that moment."],
        ["Map replay", "The game played back on the map. See [Map replay](/help/game-page-replay)."],
        ["Mechanics", "This game's macro score, spending quotient (SQ), APM, supply blocks and your race mechanics. Click a supply block to move the timeline to it."],
        ["Why you lost", "On a loss: the biggest macro causes, worst first, each with what it cost and when it happened. On a win, this card is a short note instead."],
        ["Ghost Build grade", "How closely you followed your practice build, when one is set for this matchup. See [Practice a build with Ghost Build](/help/practice-ghost-build)."],
        ["Build orders", "Both players' build orders side by side, with the time and supply of each step."],
      ],
    },
    { type: "heading", text: "Save the build", anchor: "save-build" },
    {
      type: "list",
      items: [
        "**Save as new build** on your build order turns this game's opening into a custom build: pick the steps that define it, name it and save. See [Detected builds vs custom builds](/help/custom-builds).",
        "**Use as Ghost Build target** keeps this game's timed build as a practice target for later games in its matchup. This source game itself is not graded.",
      ],
    },
    { type: "heading", text: "When a card is empty", anchor: "empty-cards" },
    {
      type: "list",
      items: [
        "The timeline, mechanics and build orders come from the replay's detailed data. A game synced by an old version of the desktop app may not have it: run **Re-sync** in the app to read it again.",
        "*Not enough data to explain this one* on a loss means the rules found no clear macro cause. The loss came from somewhere else, such as a fight or a timing.",
        "APM needs a game synced with desktop app 0.17.2 or newer.",
      ],
    },
    {
      type: "paragraph",
      text: "Every number on this page comes from the replay with fixed rules, never AI.",
    },
    {"type": "heading", "text": "When a section doesn't load", "anchor": "section-recovery"},
    {"type": "paragraph", "text": "A ‘Couldn't load …’ message with Retry means a temporary connection or server problem. Your replay is safe; retry that section without leaving the rest of the page. ‘Not computed yet’ or a missing-analysis explanation means this game has no analysis for that section yet. Loading placeholders mean the request is still running. If a section crashes, its Try again button remounts it while the rest of the page stays available."},
  ],
  related: ["game-page-replay", "game-page-accurate-playback", "macro", "build-check-in"],
};

export default article;
