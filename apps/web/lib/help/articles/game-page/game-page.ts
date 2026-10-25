import { REPLAY_SHORTCUTS } from "@/lib/replayControls";
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
    { type: "heading", text: "Moving between games", anchor: "moving-between-games" },
    { type: "paragraph", text: "Older and Newer step through your games with the active list filters. Choose all games, the same opponent, matchup or effective checked-in build; the scope is remembered on this device. Alt + Left and Alt + Right also step through games while you are not typing. A game opened from an opponent starts with that opponent unless you already chose a scope. Back to Replays, Macro, Builds or the opponent returns to the originating filtered list; when the browser exposes the matching previous entry, it also restores its scroll position. Copied links keep a normal backlink. The H2H chip counts recorded wins and losses against this opponent across all time when that record is available." },
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
        ["Macro", "The full macro breakdown, priced leaks, composition and match timeline. Choose Army, Workers, Supply, Income, Bank or APM when measured. Your selected metrics are remembered in this browser."],
        ["Map replay", "The game played back on the map. See [Map replay](/help/game-page-replay)."],
        ["Mechanics", "This game's macro score, spending quotient (SQ), APM, supply blocks and your race mechanics. Click a supply block to watch that moment in the replay."],
        ["Why you lost", "On a loss: the biggest macro causes, worst first, each with what it cost and when it happened. On a win, this card is a short note instead."],
        ["Ghost Build grade", "How closely you followed your practice build, when one is set for this matchup. See [Practice a build with Ghost Build](/help/practice-ghost-build)."],
        ["Build orders", "Both players' build orders side by side, with the time and supply of each step."],
      ],
    },
    { type: "heading", text: "Reading your macro breakdown", anchor: "macro" },
    { type: "paragraph", text: "Use Overview, Replay, Macro and Builds to move around this game without closing the replay. Macro includes the score's penalty bars, the biggest leaks and what went well. A priced leak estimates the resources or production time lost under fixed rules; it is a comparison aid, not a claim that it decided the result. Select a leak or a chart time to watch that moment. Bank adds unspent minerals and gas; missing samples stay unknown." },
    { type: "heading", text: "Recompute analysis", anchor: "recompute" },
    { type: "paragraph", text: "Recompute analysis asks your connected desktop app to parse the existing replay again. It records nothing new and does not generate accurate map playback. Keep the app running with access to that replay. A reparse usually takes seconds; a busy app or a long replay can take longer. The request acknowledgement means the job was queued, not finished. This page refreshes the report for up to a minute; if it still has not arrived, check the desktop app and retry. The button explains when the app is offline. Connection or server errors have Retry instead." },
    { type: "heading", text: "Jump to any moment", anchor: "jump-to-any-moment" },
    { type: "paragraph", text: "Watch at timestamps, build-order steps and the game-time slider all use one replay clock. A jump pauses playback, reveals the replay and highlights it briefly. During playback the chart cursor and current build steps follow the same time. Follow current step scrolls only the build list and starts off. Copy link at the clock, or in replay display settings, shares a link with that game time. The address updates after a jump or pause, so moving between sections keeps playback mounted." },
    { type: "heading", text: "Replay controls", anchor: "replay-controls" },
    { type: "paragraph", text: "Play, pause, speed and display settings are explained in [Map replay](/help/game-page-replay#controls). Minerals and gas appear only when measured. The upgrade chips show completed upgrades at the current time." },
    { type: "table", head: ["Key", "Action"], rows: REPLAY_SHORTCUTS },
    { type: "paragraph", text: "Click or Tab to the replay player before using shortcuts. Text fields, native controls and dialogs keep their own keys. Speed, rail visibility, production side, build filter, worker and auto-scroll choices, music volume and the phone panel choice are remembered on this device. The phone panel stays collapsed or expanded as you chose it." },
    { type: "heading", text: "Build orders", anchor: "build-orders" },
    { type: "paragraph", text: "Both players' build steps show their replay time. Select a step to watch it; the current step follows the shared game clock. Save as new build keeps the opening for later, and a Ghost target can be armed for practice." },
    { type: "heading", text: "Save the build", anchor: "save-build" },
    {
      type: "list",
      items: [
        "**Save as new build** on your build order turns this game's opening into a custom build: pick the steps that define it, name it and save. See [Detected builds and your Build library](/help/custom-builds).",
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
