import type { HelpArticle } from "@/lib/help/types";

const article: HelpArticle = {
  slug: "practice-log",
  title: "Track your practice",
  summary:
    "Every game you play in a matchup with an armed Ghost Build target is graded automatically when it uploads. The private practice log shows your grades, timing per step, where you fall off and your weekly progress.",
  category: "builds",
  audience: "player",
  signedInOnly: true,
  order: 45,
  keywords: [
    "practice log",
    "practice",
    "ghost build",
    "grade",
    "progress",
    "drift",
    "where you fall off",
    "weekly goal",
    "build order practice",
    "homework",
  ],
  updated: "2026-11-10",
  body: [
    {
      type: "paragraph",
      text: "The [practice log](/practice) turns your [Ghost Build](/help/practice-ghost-build) target into a record you can follow over weeks. It is private: no coach, public profile, share card or replay review shows these grades.",
    },
    { type: "heading", text: "Start tracking", anchor: "start" },
    {
      type: "steps",
      items: [
        "Pick the build you want to practise, from your [Build library](/builds), a guide, a community build or one of your own games, and assign it as the Ghost Build target for its matchup.",
        "Play games in that matchup as usual. Each one is graded against the target when the desktop app uploads it.",
        "Open **Practice log** under Build library to see the results. **Grade my last 20 games** grades your most recent games in the matchup against the target too, so you can see where you started.",
      ],
    },
    { type: "heading", text: "How games are graded", anchor: "grading" },
    {
      type: "list",
      items: [
        "Only games played after the target was armed are graded automatically, so re-syncing your history never grades old games against today's target. Games graded on request are labelled and drawn as hollow dots.",
        "A game is graded once. Changing the target later starts a new log for the new build and leaves earlier grades as they were; pick an earlier target from the Target menu to see its games.",
        "The grade uses the same rules as the grade on a game page: steps are matched in order by name, drift is how many seconds early or late each step was, and a step more than 30 seconds off counts as the point you fell off the build. S means every step within 5 seconds on average; D means a different build.",
        "A game uploaded without a build log is counted but not graded, and the log says how many.",
      ],
    },
    { type: "heading", text: "Reading the page", anchor: "reading" },
    {
      type: "list",
      items: [
        "**Last grades**: your latest 30 grades, oldest to newest, with how many games reached each grade.",
        "**This week**: games at B or better since Monday against a weekly goal you set. The goal is saved on this device.",
        "**Per-step timing**: each step's average drift in the games where you built it, and how often you built it.",
        "**Where you fall off**: the steps where games most often first left the build.",
        "**Graded games**: every graded game with its steps hit, average drift and the step where it diverged. Open a game to see the full breakdown.",
      ],
    },
    {
      type: "paragraph",
      text: "Clearing a matchup's target hides that matchup here until you arm a build for it again; the grades stay on your games. Grades come from your replays with fixed rules, never AI.",
    },
  ],
  related: ["practice-ghost-build", "custom-builds", "game-page"],
};

export default article;
