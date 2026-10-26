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
  updated: "2026-10-25",
  body: [
    {
      type: "paragraph",
      text: "When a game starts, SC2 Tools turns your earlier games against the identified opponent into a short briefing. Your record, notes and observed counts come from **your own replays** in **this matchup**, with optional linked-account grouping. The opening forecast can also use a clearly labelled, cached public ladder mix. It never borrows another user's private opponent notes or history.",
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
          "Head-to-head, last games, your notes, best answer, cheese, and where games against them usually end, like \"Mid/Late game · Your army: Carrier, Tempest\".",
          "An identified opponent. The \"Games usually end\" line needs 3 games with full replay detail.",
        ],
      ],
    },
    { type: "heading", text: "Where the numbers come from" },
    {
      type: "list",
      items: [
        "**Which games.** The latest 50 matching saved game summaries: your account, this opponent or resolved group, and both races. Hidden, deleted, resumed and other-matchup games do not use a slot. Short games and unreliable lengths then lower the forecast sample without refilling it with older games. Playing Protoss into their Zerg uses PvZ, not games where they played Terran.",
        "**Which label.** The opening the replay recognised, or the one you chose when you corrected their build with [build check-in](/help/build-check-in).",
        "**Recent games count more.** The opening forecast uses the formula below. The separate cheese-history percentage retains its plain legacy recency rule: the last ten count double.",
        "**The favourite opening share is plain.** 3 of last 5 games is 60%.",
        "**What counts as cheese.** Openings whose name includes a proxy, a cannon rush, an early pool (6, 8 or 12 pool, pool first), an all-in, a bunker rush or a worker rush.",
      ],
    },
    { type: "heading", text: "Alternate accounts", anchor: "alternate-accounts" },
    { type: "paragraph", text: "Turn **Group same player** on or off in the Opponents list or dossier. This choice is saved to your signed-in account and also controls live scouting across devices. Grouping uses approved shared identities or an already-cached Battle.net account link, never a similar display name. Scouting does not start new Pulse lookups to discover alts. Missing or contradictory cached links keep the accounts separate." },
    { type: "paragraph", text: "Up to 20 of your recorded accounts can contribute to one scouting group. The **also:** chip names other observed accounts. Record, recent meetings and forecast combine that group's games; your note still belongs to the exact current account and is never copied from a sibling. Turning grouping off returns to the current account. The next live update uses the saved choice." },
    { type: "heading", text: "How the forecast works", anchor: "how-the-forecast-works" },
    { type: "list", items: [
      "**Recency:** the newest eligible observation has weight 1. Each following eligible observation has weight 2^(-age/8), so after eight observations it has half the weight. An unlabelled game keeps its share rather than inflating the known openings.",
      "**Map:** an observation on the selected/current known map gets 1.5 times that weight. Without a known map, all maps use their ordinary weights. The live desktop feed may not supply a map; it does not guess one from your previous game.",
      "**Ladder prior:** when a suitable cached ladder row exists, its opening mix adds three pseudo-games. To forecast their Zerg opening against your Protoss, this is the ZvP mix against your recorded rating band. If your rating or that table is unavailable, there is no prior. The caption identifies a last-recorded rating; no new live corpus computation runs.",
      "**Effective n:** the sum of your personal observation weights, including the map factor. It is weighted evidence, not a literal game count. The ladder's three pseudo-games do not increase it. Confidence is Low below 3, Medium from 3 to below 8, and High at 8 or more. A single observation can still produce 100%, labelled Low; it is not certainty.",
      "**Top three:** their probabilities are shares of all openings. Other and unlabelled openings keep the remaining share. The reasons are raw counts, such as 3 of last 5 vs you or 2 of 2 on this map; a weighted percentage need not equal those plain counts.",
      "**One method:** the dossier, live brief, overlay and desktop brief use this same deterministic result for the same cohort and context. Analyzer filters or a selected map can change that context. The dossier's date window and local history row selections do not change this recent-history forecast.",
    ] },
    { type: "callout", tone: "info", title: "A bounded, honest sample", text: "Forecasts use eligible observations within the latest 50 matching game summaries. Missing/invalid lengths and games under 45 seconds are left out. The dossier also keeps its existing 1,000-summary limit; if that limit is reached before the matching source window can be completed, it shows forecast unavailable instead of filling the gap with the older estimate. Everything uses fixed replay rules, without AI or model APIs." },
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
