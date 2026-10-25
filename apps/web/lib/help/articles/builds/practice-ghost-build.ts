import type { HelpArticle } from "@/lib/help/types";

const article: HelpArticle = {
  slug: "practice-ghost-build",
  title: "Practice a build with Ghost Build",
  summary:
    "Choose a local or synced replay, preview either player's opening, and follow its steps in the native desktop Ghost panel. Website targets also support post-game timing grades.",
  category: "builds",
  audience: "player",
  signedInOnly: true,
  order: 40,
  keywords: [
    "ghost build",
    "ghost",
    "practice",
    "build order practice",
    "timings",
    "coach",
    "voice coach",
    "save for",
    "matchup build coach",
    "grade",
    "drift",
    "first divergence",
    "homework",
    "random opponents",
  ],
  updated: "2026-10-23",
  body: [
    { type: "callout", tone: "info", title: "Agent 0.24.1 and later", text: "Update the [Windows agent](/download) for the native Ghost controls below. Website targets and optional OBS setup remain available. See [Desktop Companion](/help/desktop-companion)." },
    {
      type: "paragraph",
      text: "Build Order Ghost follows a replay's timed opening against your current game clock. In the Windows **Companion → Build Order Ghost** tab you can configure and use the native panel without OBS. Choose a source, inspect its actual steps and assign it to a matchup before turning the panel on.",
    },
    { type: "heading", text: "Choose a native Ghost target", anchor: "native-target" },
    { type: "steps", items: [
      "Open **Companion → Build Order Ghost** in the desktop app. Choose a local **.SC2Replay** or drop one onto Ghost, select a synced replay, or choose an available example explicitly published by an admin.",
      "Preview both players' available build orders. Select the player whose opening you want, review the matchup and timings, then assign that target to the matchup slot.",
      "Turn on **Show Build Order Ghost during matching games** and Companion's **Game assistance enabled** master switch. The native panel follows the game clock above the game; Windowed or Windowed (Fullscreen) mode is needed.",
      "Turn Ghost or the master switch off at any time to hide the panel without clearing assigned targets. **Clear matchup** removes the selected target.",
    ] },
    { type: "image", src: "/landing/companion-ghost.png", alt: "Native Ghost source selection and both-player build preview", caption: "Actual desktop interface, shown with sample replay data." },
    { type: "heading", text: "Keep a reference replay for each build", anchor: "references" },
    { type: "paragraph", text: "In **Builds** or **Opponents**, use a replay's star action to save it as that build's reference example. Select a reference in Ghost when you want to practice it, then choose the source player and assign the target. A reference is tied to a build; it does not replace all matchup slots. Private sources are not published automatically, and shared admin examples are an optional source." },
    { type: "callout", tone: "info", title: "What the live panel knows", text: "Native Ghost follows scheduled replay steps against the SC2 game clock. It does not read live unit or building completion from the game client. Its timing list is a guide, not a claim that you completed a step." },
    { type: "paragraph", text: "Use the replay library's search, matchup, build, map, result and reference-only filters to narrow loaded games. **Reference history / Undo** keeps the last three previous examples per build. Restoring an example asks for confirmation and refuses to overwrite a newer change from another device." },
    { type: "paragraph", text: "For a completed replay, **Compare with reference** shows historical timing differences, including repeated buildings or units matched in order. Start timings compare with starts and completion timings with completions. Missing observations are not fabricated, and the source replay itself is excluded." },
    { type: "heading", text: "Optional website target and grading", anchor: "save" },
    {
      type: "steps",
      items: [
        "Open a game where you played the build well, ideally a clean win.",
        "Open one of your games and choose **Use as Ghost Build target** above your build order (the short phone label is **Ghost target**).",
        "A concrete matchup is required. That replay becomes the target for later games in the same matchup on this device; the source game itself is not graded.",
        "If another target is already armed, confirm the replacement. Use **Undo** in the success message to restore the previous targets, or **Disarm** to stop grading that matchup.",
        "The website target enables grading of later games in that matchup in this browser. An OBS display of those target steps is optional; native Companion has its own source assignments.",
        "Do the same for any other matchup you want to practice. Each of the nine matchups has its own slot.",
      ],
    },
    { type: "heading", text: "Optional OBS coach setup", anchor: "assign" },
    {
      type: "steps",
      items: [
        "Open [Settings → Overlay](/settings?tab=overlay) and go to **Ghost Build coach**.",
        "Under **Matchup build coach**, pick one saved build for each matchup you want coached. The badge shows how many of the nine are ready.",
        "Your choices are stored in this browser and built into the Ghost Build widget's URL, so copy the URL again after any change.",
      ],
    },
    { type: "heading", text: "Optional OBS display", anchor: "overlay" },
    {
      type: "steps",
      items: [
        "In **OBS Browser Source URLs** on the same page, find **Ghost Build coach** and copy its URL. Turn on **Voice coach** next to it first if you want each step read out a few seconds before it's due.",
        "Add the URL to OBS as its own Browser Source. It's separate from the all-in-one overlay.",
        "Between games it shows that a build is armed. When a game starts, it waits for both races, then shows the previous, current and next step against the game clock, with a drift chip saying how early or late you are.",
      ],
    },
    {
      type: "paragraph",
      text: "Use the native Companion panel when you want Ghost without a browser source. For an on-stream display, see [OBS overlay setup](/help/obs-overlay-setup).",
    },
    { type: "heading", text: "Read a website target's grade", anchor: "grade" },
    {
      type: "paragraph",
      text: "After the game, the game page shows a **Ghost Build grade** card when a website target is set for that matchup in this browser. Selecting a native Companion source does not by itself set a website grading target.",
    },
    {
      type: "table",
      head: ["Grade", "What it takes"],
      rows: [
        ["S", "Every step done, on average within 5 seconds of its time, never more than 15 seconds off."],
        ["A", "At least 90% of the steps, on average within 10 seconds, never more than 30 seconds off."],
        ["B", "At least 75% of the steps, on average within 20 seconds."],
        ["C", "At least half the steps, on average within 40 seconds."],
        ["D", "Anything less."],
      ],
    },
    {
      type: "list",
      items: [
        "**Steps hit**, **Avg drift** and **Max drift** show how close you were.",
        "**First divergence** names the first step you skipped or did more than 30 seconds off its time. That's usually where to look in the replay.",
        "**Per-step breakdown** lists every step: green within 5 seconds, amber within 15, red beyond that or missed.",
        "**Disarm** stops grading that matchup in this browser.",
      ],
    },
    { type: "heading", text: "Good to know", anchor: "limits" },
    {
      type: "list",
      items: [
        "Ghost pauses for the whole game against a Random opponent, so it never coaches the wrong matchup once their race shows.",
        "Both native and OBS displays need the desktop app running to receive the game clock.",
        "Website targets live in this browser; native target assignments are saved on this desktop. Review the selected source after switching computers.",
      ],
    },
  ],
  related: ["desktop-companion", "custom-builds", "game-page", "randomizer", "obs-overlay-setup"],
};

export default article;
