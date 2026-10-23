import type { HelpArticle } from "@/lib/help/types";

const article: HelpArticle = {
  slug: "opponent-dossier",
  title: "Opponent dossier: one player in depth",
  summary:
    "Everything you know about one opponent: your record, their builds and what they'll likely do next, your scouting notes, their real identity behind a barcode, and how to fix a missing Pulse ID.",
  category: "opponents",
  audience: "player",
  signedInOnly: true,
  order: 1,
  keywords: [
    "dossier",
    "opponent profile",
    "deep dive",
    "scouting notes",
    "notes",
    "read aloud",
    "voice",
    "likely strategies",
    "build tendencies",
    "h2h",
    "head to head",
    "where games end",
    "pulse id missing",
    "sc2pulse id not resolved",
    "retry",
    "diagnostics",
    "barcode",
    "identity",
    "smurf",
    "public profile",
    "community profile",
  ],
  updated: "2026-10-23",
  body: [
    {
      type: "paragraph",
      text: "Click any row in [Opponents](/app/opponents) to open that player's dossier. It is private to you and built only from your own games against them, filtered by the filter bar like the rest of the analyzer.",
    },
    { type: "heading", text: "What's on the page", anchor: "sections" },
    {
      type: "table",
      head: ["Part", "What it tells you"],
      rows: [
        ["Header", "Their name, MMR and Pulse ID, your games, wins, losses and win rate against them, and their Twitch or YouTube channel when they've connected one."],
        ["Scouting notes", "Your own notes about this player. See below."],
        ["Ladder MMR by race and ladder context", "Their current rating, league and recent form from SC2Pulse."],
        ["By map, By strategy", "Your record against them on each map, and against each opening they used."],
        ["Build tendencies", "The openings they use most against you, over time."],
        ["Likely strategies next", "What they're most likely to open with next time, weighted toward your last 10 games against them."],
        ["H2H trends", "Your games against them as a timeline, your streaks, and maps and build pairings side by side."],
        ["Where games end", "Whether your games against them tend to end early, in the mid game or late."],
        ["Replay history", "Every game against them, newest first, with a link to each game page."],
      ],
    },
    { type: "heading", text: "Narrow it down", anchor: "drill-down" },
    {
      type: "paragraph",
      text: "In **H2H trends**, open the **Maps** or **Builds** tab and pick a map or a pairing of your build and theirs. The replay history then lists only those games. Pick it again to go back to every game.",
    },
    { type: "heading", text: "Scouting notes and read-aloud", anchor: "notes" },
    {
      type: "list",
      items: [
        "Write what you want to remember, for example *Hides tech after early pressure*, and press **Save notes**. Notes are private.",
        "When the desktop app detects this player at the start of a game, your notes show on your private scouting overlay.",
        "Turn on **Read notes aloud** to hear them at the start of the game too. It needs the voice readout on, with **Scouting report (pre-game)** ticked: see [Voice readout](/help/voice).",
      ],
    },
    { type: "heading", text: "Pulse ID or MMR missing", anchor: "pulse-id-missing" },
    {
      type: "paragraph",
      text: "SC2 Tools looks up each opponent on SC2Pulse to find their Pulse ID and current MMR. Until that works, the header shows their toon instead of a Pulse ID, and MMR and ladder context stay empty.",
    },
    {
      type: "steps",
      items: [
        "Open **Identity & MMR diagnostics** on the dossier. It shows whether their Pulse ID was found, their toon, region and when MMR was last fetched.",
        "Press the **Retry** button there. It asks SC2Pulse again right away.",
        "If it's found, the Pulse ID, MMR and ladder context fill in, and your older games against them are updated too. If it still isn't, SC2Pulse doesn't list the player yet, often because they haven't played enough ranked games this season. Try again later.",
      ],
    },
    { type: "heading", text: "Barcodes and real identities", anchor: "barcode" },
    {
      type: "paragraph",
      text: "A *barcode* is a name made only of look-alike characters such as IIlIlI, used to hide who's playing. When SC2 Tools knows who it is, from SC2Pulse or from an identity confirmed by our team, their real name shows next to the barcode.",
    },
    {
      type: "list",
      items: [
        "**Possible identity matches** compares this barcode with the players in your own replays: build patterns, control groups and replay actions. These are private leads, never proof, and the panel says how strong the evidence is.",
        "Know who it is? Under **Player identity**, pick their known account and explain the match in at least 10 characters, for example a stream or replay detail that can be checked. Press **Submit for review**.",
        "An administrator checks the evidence. Once approved, the identity shows for everyone. Your submission shows **Awaiting review**, **Approved** or **Not approved**, with a note from the reviewer.",
      ],
    },
    { type: "heading", text: "The public profile", anchor: "public-profile" },
    {
      type: "paragraph",
      text: "Once at least 5 different SC2 Tools players have faced this opponent, a **Public profile** link appears in the header. That page is open to everyone and combines all of those players' games: race, record, strategies seen and maps, counted from the opponent's side. It never shows names, battle tags, or who contributed.",
    },
    { type: "heading", text: "How much data it needs", anchor: "sample-size" },
    {
      type: "list",
      items: [
        "Everything works from one game, but tendencies and predictions mean little until you've played someone a few times.",
        "Map rows with fewer than 2 games are marked as a low sample in H2H trends.",
        "Likely strategies next counts your last 10 games against them double, so a recent change of style shows up quickly.",
      ],
    },
    {
      type: "paragraph",
      text: "Every number comes from replays with fixed rules, never AI. To read the list of all your opponents, see [Opponents](/help/opponents).",
    },
  ],
  related: ["opponents", "opponent-scouting", "voice", "analyzer-filters"],
};

export default article;
