import type { HelpArticle } from "@/lib/help/types";

const article: HelpArticle = {
  slug: "builds",
  title: "Build stats: how each of your builds performs",
  summary:
    "Your record with every build you play, how each build does at different MMRs, how you get better at a build with practice, and where to edit or publish one.",
  category: "analyzer",
  audience: "player",
  signedInOnly: true,
  order: 8,
  keywords: [
    "builds",
    "build win rate",
    "my builds",
    "build stats",
    "win rate by mmr",
    "build mastery curve",
    "mmr progression by build",
    "planned",
    "unclassified",
    "reclassify my games",
    "personal notes",
    "publish to community",
    "build mix over time",
  ],
  updated: "2026-10-25",
  body: [
    {
      type: "paragraph",
      text: "The [Build stats](/app/builds) section of the analyzer lists every build you've played in the games the filter bar lets through: the openings SC2 Tools detects and the custom builds you've defined. It answers: which builds win, which don't, and which ones I'm getting better at.",
    },
    { type: "heading", text: "The build table", anchor: "table" },
    {
      type: "list",
      items: [
        "One row per build with wins, losses, games and win rate. Search by name, and sort by win rate with the arrow button or by any column header.",
        "**incl. N check-ins** means N of the games count only because you checked in to this build. See [Build check-in](/help/build-check-in).",
        "Click a row to open the build: its record by matchup and map, recent games, your **Personal notes**, and **Publish to community** for a build saved in your library.",
        "Use Tab to reach a build name, then Enter to open it. The **W/L split** bar shows wins against losses. Matchup chips such as **vZ 20** use the global opponent-race filter; they do not create another independent filter.",
      ],
    },
    { type: "paragraph", text: "**Export CSV** saves exactly the table rows on screen after search, Min games and sorting, with your filters written in the first line. The filename uses your local date. Win rates stay raw numbers for spreadsheet calculations; unavailable strength comparisons stay blank." },
    { type: "heading", text: "The charts", anchor: "charts" },
    {
      type: "table",
      head: ["Chart", "What it answers"],
      rows: [
        ["Build mix over time", "Recorded game counts for each build and calendar period. Select a period to read its counts; empty dates remain gaps. Grouping shares your Day, Week or Month preference with Trends and Mechanics progress."],
        ["Win rate by MMR — your builds", "One line per build, with your MMR when you played it along the bottom. Shows which builds hold up as you climb."],
        ["Build mastery curve", "Your running win rate with each build by how many times you've played it, not by date: an early dip that climbs means the build is settling in."],
        ["MMR progression by build", "Your MMR over time, split by the build you played."],
      ],
    },
    { type: "heading", text: "Games without a build name", anchor: "unclassified" },
    {
      type: "paragraph",
      text: "Very old uploads can be listed as *Unclassified - Zerg* or *Unclassified - Terran*: they were synced before those builds were detected. Press **Reclassify my games** in the banner and the desktop app reads those replays again with today's rules. It must be running, with the replays still on your PC.",
    },
    { type: "heading", text: "How much data it needs", anchor: "sample-size" },
    {
      type: "list",
      items: [
        "**Min games** hides builds you've played fewer times than the number you pick.",
        "The MMR charts skip MMR ranges with fewer games than Min games, so a build only shows where it has enough games.",
        "The mastery curve has its own **Min plays per build**: builds played fewer times aren't drawn, so one lucky first game doesn't dominate it.",
      ],
    },
    {
      type: "paragraph",
      text: "Want to define your own version of an opener, with its own record? See [Detected builds and your Build library](/help/custom-builds). Every number here is counted from your replays with fixed rules, never AI.",
    },
  ],
  related: ["custom-builds", "strategies", "build-check-in", "reading-the-charts"],
};

export default article;
