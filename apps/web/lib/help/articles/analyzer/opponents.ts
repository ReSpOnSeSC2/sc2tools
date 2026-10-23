import type { HelpArticle } from "@/lib/help/types";

const article: HelpArticle = {
  slug: "opponents",
  title: "Opponents: everyone you've played",
  summary:
    "Read the Opponents list: your record against each player, how accounts of the same player are grouped, what MMR impact and Net MMR mean, and Pulse IDs vs toons.",
  category: "analyzer",
  audience: "player",
  signedInOnly: true,
  order: 3,
  keywords: [
    "opponents",
    "opponent list",
    "head to head",
    "h2h",
    "record",
    "group same player",
    "merge accounts",
    "mmr impact",
    "net mmr",
    "mmr won",
    "mmr lost",
    "verified pairs",
    "last mmr",
    "pulse id",
    "sc2pulse",
    "toon",
    "toon handle",
    "barcode",
    "min games",
  ],
  updated: "2026-10-23",
  body: [
    {
      type: "paragraph",
      text: "[Opponents](/app/opponents) lists every player you've faced in the games the filter bar lets through, with your record against each one. It answers: who do I play most, who do I beat, who beats me, and who costs me the most MMR.",
    },
    { type: "heading", text: "What each column means", anchor: "columns" },
    {
      type: "table",
      head: ["Column", "What it shows"],
      rows: [
        ["Opponent", "Their name in your games. When the player behind a barcode name is known, their real name shows next to it."],
        ["Pulse ID", "Their SC2Pulse ID, or their toon when SC2Pulse doesn't know them yet. See below."],
        ["W, L, Win rate, Games", "Your record against them."],
        ["Last MMR", "Their MMR in the most recent game you played against them."],
        ["Net MMR", "The MMR you gained or lost against them in total, from verified pairs."],
        ["MMR won, MMR lost", "The two halves of Net MMR: all the MMR you gained against them, and all you lost."],
        ["Last", "When you last played them."],
      ],
    },
    {
      type: "paragraph",
      text: "Click a column header to sort by it; click again to reverse. Click a row to open that opponent's dossier.",
    },
    { type: "heading", text: "Search, sort and share", anchor: "search-sort-share" },
    { type: "paragraph", text: "Press **/** to focus search and **Esc** to clear it. **Reset** restores this page's search, minimum games, MMR impact, notes, grouping and sort without changing the global filters. Names sort naturally, ignoring case and accents; Pulse IDs sort numerically. Equal win rates put the larger sample first, then the name. Missing values stay last in either direction." },
    { type: "paragraph", text: "Bookmark or share the address bar to keep the search, sort, MMR impact and **Has notes** choice. Ctrl/Cmd-click or middle-click a name or dossier arrow to open another tab. **All opponents** returns to the prior list, expanded rows and scroll position. A new tab uses the last list address when available." },
    { type: "paragraph", text: "A note icon shows your private scouting preview on hover or keyboard focus. Grouped players show the first member's preview and how many more have notes. **Has notes** limits the list to players with a saved note." },
    { type: "heading", text: "Group same player", anchor: "group-same-player" },
    {
      type: "paragraph",
      text: "Many players have more than one account: other regions, smurfs, renamed accounts. With **Group same player** on, accounts that SC2Pulse links to the same player, or that are confirmed as the same person, are merged into one row with their combined record. Expand the row to see each account. Turn it off to see every account on its own row. The choice is remembered on this device, and the dossier follows it.",
    },
    { type: "heading", text: "MMR impact", anchor: "mmr-impact" },
    {
      type: "paragraph",
      text: "**Opponent MMR impact** at the top of the page names the players you've won the most MMR from and lost the most MMR to. The **MMR impact** menu next to the search box narrows the list: **Verified pairs only** shows opponents with at least one measured MMR change, **You gained overall** and **They gained overall** split them by Net MMR.",
    },
    { type: "heading", text: "Net MMR and verified pairs", anchor: "net-mmr" },
    {
      type: "paragraph",
      text: "Your replays record your MMR at the start of each ranked game. The change from one game is your MMR at the start of the next ranked game minus your MMR at the start of this one. That pair of games is a **verified pair** when both are ranked 1v1, on the same account, with the same race, one right after the other in your synced replays.",
    },
    {
      type: "list",
      items: [
        "A game without a following ranked game (your latest game, or the last game before a gap) has no measured change yet.",
        "A pair whose change is bigger than 150 MMR is left out: something happened in between that the replays don't show.",
        "Net MMR adds up every verified change against one opponent. The number under it is how many pairs it comes from; a dash means none yet.",
      ],
    },
    { type: "heading", text: "Pulse ID or toon", anchor: "pulse-id" },
    {
      type: "list",
      items: [
        "A **toon** is the account ID inside the replay, such as `1-S2-1-267727`: region, realm and account number. Every replay has one.",
        "A **Pulse ID** is the player's ID on [SC2Pulse](https://sc2pulse.nephest.com/sc2/), the public ladder site. It follows the player across name changes, and it brings their current MMR, league and linked accounts.",
        "SC2 Tools looks up each opponent's Pulse ID from their toon. Until it's found the column shows the toon. If it stays missing, open the dossier and see [Opponent dossier](/help/opponent-dossier).",
      ],
    },
    { type: "heading", text: "How much data it needs", anchor: "sample-size" },
    {
      type: "list",
      items: [
        "**Min games** hides opponents you've played fewer times than the number you pick. Set it to 1 to see everyone.",
        "A win rate over 1 or 2 games says little. Win rates are colored only from 3 games up; below that they stay grey.",
        "Net MMR needs verified pairs, so opponents from your oldest replays, or from unranked games, can show none.",
      ],
    },
    {
      type: "paragraph",
      text: "Everything here is computed from your replays with fixed rules, never AI. For one player in depth, see [Opponent dossier](/help/opponent-dossier).",
    },
  ],
  related: ["opponent-dossier", "analyzer-filters", "reading-the-charts", "opponent-scouting"],
};

export default article;
