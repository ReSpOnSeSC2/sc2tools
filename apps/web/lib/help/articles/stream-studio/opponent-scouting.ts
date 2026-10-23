import type { HelpArticle } from "@/lib/help/types";

const article: HelpArticle = {
  slug: "opponent-scouting",
  title: "Opponent scouting: what the overlay shows and where the numbers come from",
  summary:
    "The Favourite opening, Cheese alert, Best answer and Scouting report widgets read your own games against the opponent. What each number means, how many games it needs and how to fix a wrong label.",
  category: "stream-studio",
  audience: "streamer",
  signedInOnly: true,
  order: 2,
  keywords: [
    "scouting",
    "scouting report",
    "favourite opening",
    "favorite opener",
    "best answer",
    "cheese",
    "cheese alert",
    "prediction",
    "predicted strategies",
    "opener",
    "opening",
    "games usually end",
    "of last 5 games",
    "widget empty",
    "overlay",
  ],
  updated: "2026-10-23",
  body: [
    {
      type: "paragraph",
      text: "When a game starts, SC2 Tools looks up your earlier games against this opponent and turns them into a short briefing for the overlay. Every number comes from **your own replays** against that exact account (matched by their Battle.net account, not just the name), in **this matchup**. Nothing is borrowed from other players' games.",
    },
    { type: "heading", text: "What each widget shows" },
    {
      type: "table",
      head: ["Widget", "What it shows", "Needs"],
      rows: [
        [
          "Favourite opening",
          "The opening they used most, its share, and how many games that is, like \"3 of last 5 games\".",
          "2 earlier games in this matchup, with the same opening twice.",
        ],
        [
          "Cheese alert",
          "How often they opened with cheese against you. Appears at 40% or more, with the games behind it.",
          "2 earlier games in this matchup.",
        ],
        [
          "Best answer",
          "Your build with the best record against their favourite opening, from all your games in the matchup.",
          "A favourite opening, plus 3 of your games with one build against it.",
        ],
        [
          "Scouting report",
          "Head-to-head, last games, your notes, best answer, cheese, and where games against them usually end, like \"Mid/Late game · Carrier, Tempest\".",
          "An identified opponent. The \"Games usually end\" line needs 3 games with full replay detail.",
        ],
      ],
    },
    { type: "heading", text: "Where the numbers come from" },
    {
      type: "list",
      items: [
        "**Which games.** Your last 50 games against this opponent, then only the ones in this matchup. Playing Protoss into their Zerg uses your PvZ games; games where they played Terran don't count. Games shorter than 45 seconds are left out.",
        "**Which label.** The opening the replay recognised, or the one you chose when you corrected their build with [build check-in](/help/build-check-in).",
        "**Recent games count more.** For the cheese percentage and the predicted strategies, your last 10 games against them count double. That's the same prediction the opponent dossier shows, so the overlay and the dossier agree.",
        "**The favourite opening share is plain.** 3 of last 5 games is 60%.",
        "**What counts as cheese.** Openings whose name includes a proxy, a cannon rush, an early pool (6, 8 or 12 pool, pool first), an all-in, a bunker rush or a worker rush.",
      ],
    },
    {
      type: "callout",
      tone: "info",
      title: "History, not a live read",
      text: "These widgets show what this opponent has done against you before. They can't see what they're building in this game, so scout as usual.",
    },
    { type: "heading", text: "When they appear" },
    {
      type: "paragraph",
      text: "At the start of a real game, once the desktop app has identified your opponent. The stats ticker uses the same numbers. After the game, the result card counts the game you just played too; with no earlier games, it can still flag a cheese you just faced.",
    },
    { type: "heading", text: "If a widget stays empty" },
    {
      type: "list",
      items: [
        "**New opponent, or one earlier game in this matchup.** There's nothing to go on yet.",
        "**Every opening was different.** There's no favourite opening, so there's no best answer either.",
        "**Cheese below 40%.** The alert stays hidden on purpose.",
        "**Opponent not identified.** The overlay needs their Battle.net account; a name alone isn't enough, because many players share names.",
        "**The replay named their opening wrong.** Correct it on the game page's Build check-in card. From the next game, the widgets count it your way.",
      ],
    },
    { type: "settingsLink", label: "Widget guides in Stream Studio", href: "/stream-studio/learn" },
    { type: "settingsLink", label: "Open Settings → Overlay", href: "/settings?tab=overlay" },
  ],
  related: ["obs-overlay-setup", "build-check-in", "stream-dock"],
};

export default article;
