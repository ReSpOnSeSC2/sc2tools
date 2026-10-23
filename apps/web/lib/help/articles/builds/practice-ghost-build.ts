import type { HelpArticle } from "@/lib/help/types";

const article: HelpArticle = {
  slug: "practice-ghost-build",
  title: "Practice a build with Ghost Build",
  summary:
    "Save a timed build from one of your games, follow it step by step on an overlay while you play, and get a grade on how closely you hit each timing.",
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
    {
      type: "paragraph",
      text: "Ghost Build is a practice loop for a build order. You pick a timed build for a matchup, follow its next steps on an overlay while you play, then see a grade on the game page for how closely you hit each timing. It runs on your own games and your own timings; nothing is guessed.",
    },
    { type: "heading", text: "1. Save a timed build", anchor: "save" },
    {
      type: "steps",
      items: [
        "Open a game where you played the build well, ideally a clean win.",
        "Open one of your games and choose **Use as Ghost Build target** above your build order (the short phone label is **Ghost target**).",
        "A concrete matchup is required. That replay becomes the target for later games in the same matchup on this device; the source game itself is not graded.",
        "If another target is already armed, confirm the replacement. Use **Undo** in the success message to restore the previous targets, or **Disarm** to stop grading that matchup.",
        "Open Settings → Overlay to copy the updated Ghost Build overlay URL. The overlay shows the target steps as you play, and the grade appears on later games in that matchup.",
        "Do the same for any other matchup you want to practice. Each of the nine matchups has its own slot.",
      ],
    },
    { type: "heading", text: "2. Choose what Ghost coaches", anchor: "assign" },
    {
      type: "steps",
      items: [
        "Open [Settings → Overlay](/settings?tab=overlay) and go to **Ghost Build coach**.",
        "Under **Matchup build coach**, pick one saved build for each matchup you want coached. The badge shows how many of the nine are ready.",
        "Your choices are stored in this browser and built into the Ghost Build widget's URL, so copy the URL again after any change.",
      ],
    },
    { type: "heading", text: "3. Put it on screen", anchor: "overlay" },
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
      text: "Don't stream? You can still keep the source open in a browser window on a second screen. See [OBS overlay setup](/help/obs-overlay-setup) for adding a Browser Source.",
    },
    { type: "heading", text: "4. Read your grade", anchor: "grade" },
    {
      type: "paragraph",
      text: "After the game, the game page shows a **Ghost Build grade** card when a build is set for that matchup in this browser.",
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
        "The overlay needs the desktop app running to follow the game clock.",
        "Your Ghost builds live in this browser. On another computer, save them again from a game, or reuse the copied URL there.",
      ],
    },
  ],
  related: ["custom-builds", "game-page", "randomizer", "obs-overlay-setup"],
};

export default article;
