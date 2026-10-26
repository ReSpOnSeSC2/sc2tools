import type { HelpArticle } from "@/lib/help/types";

const article: HelpArticle = {
  slug: "replays",
  title: "Replays: your game history",
  summary:
    "Search every synced game, open its analysis, download the original replay or jump to your stream at that moment, and share your replay archive if you want to.",
  category: "analyzer",
  audience: "player",
  signedInOnly: true,
  order: 9,
  keywords: [
    "replays",
    "replay archive",
    "game history",
    "match history",
    "search games",
    "download replay",
    "sc2replay",
    "vod",
    "stream link",
    "macro breakdown",
    "share replay page",
    "public replays",
    "newer",
    "older",
  ],
  updated: "2026-10-26",
  body: [
    {
      type: "paragraph",
      text: "[Replays](/app/replays) lists every synced game, newest first, 25 to a page. It's where you find a specific game to review.",
    },
    { type: "heading", text: "Find a game", anchor: "find" },
    {
      type: "list",
      items: [
        "Search by player, map, build or strategy. **All**, **Wins** and **Losses** narrow the result; All includes ties. Use the matchup menu or show the oldest games first.",
        "The global filter bar still applies. **Jump to date** includes that day and earlier games; it never extends an earlier global end date. Remove the Before chip to clear it. **Reset** or **Clear replay filters** clears only this page's controls. **Reset all filters** also restores global defaults when offered.",
        "Use **Newer** and **Older** to page through. Search, result, matchup, date and sort changes return to the newest matching page. The address keeps these controls and the page, so refresh, copied links and Back from a game retain your place and scroll to its row. If this browser no longer knows the previous cursor, **Back to newest** replaces Newer.",
      ],
    },
    { type: "paragraph", text: "The compact archive header keeps the count and **Share** controls together. The introductory tip can be dismissed on this device. Sharing still requires the existing confirmation; local searches or copied analyzer links do not publish your archive." },
    { type: "heading", text: "What each row shows", anchor: "rows" },
    {
      type: "list",
      items: [
        "The result, when it was played, the matchup and map, your build and their strategy, and the game's length, MMR and macro score.",
        "**Streams:** when you or your opponent streamed the game and the recording is known, a link jumps to that moment in the recording.",
        "Open the replay analysis for the full game page, or the macro breakdown for that game's economy in a window.",
      ],
    },
    { type: "heading", text: "Download the original replay", anchor: "download" },
    {
      type: "paragraph",
      text: "Each row, and each game page, has a download button for the original .SC2Replay file, when the file was kept as the game synced. A game synced before original files were kept has no file to download yet: run **Re-sync** in the desktop app to upload it again, as long as the replay is still on your PC.",
    },
    { type: "heading", text: "Share your replay archive", anchor: "share" },
    {
      type: "steps",
      items: [
        "Press **Share** at the top of the page. Sharing status is checked before its controls become available.",
        "Read **Exactly what visitors can see**: every synced game, not only the ones in your current filters, with maps, results, names, races, MMR, builds, macro scores, stream links and the original files to download.",
        "Press **Turn on and copy link**. Send the link to a teammate, coach or your viewers.",
      ],
    },
    {
      type: "paragraph",
      text: "Visitors need to sign in to open the full analysis of a game. Press **Turn off sharing** at any time to close the page and stop new downloads. Your replay page keeps the same address if you turn it on again later.",
    },
    { type: "paragraph", text: "**Turn on and copy link** changes sharing first. If copying is unavailable or takes too long, **Copy replay page link manually** shows the selected address. Use Ctrl+C, ⌘C or your browser's Copy command. **Done**, the close button or Escape returns to the current copy action. Closing manual copy does not turn sharing off; use **Turn off sharing** separately." },
    { type: "paragraph", text: "If an update ends without confirmation, **Check sharing status** refreshes the current setting before another change or copy. A change already sent may have completed even if you closed its dialog. A settings-load failure also offers a status check, without assuming sharing is on or off." },
    { type: "paragraph", text: "On a public replay page, **Share replay page** opens your device's native sharing sheet when available. Closing that sheet cancels sharing quietly. If the device cannot share, the copy action and selected-address dialog remain available; cancelling the native sheet does not copy a link automatically." },
    {
      type: "callout",
      tone: "warning",
      title: "Original replays contain more than the stats",
      text: "An .SC2Replay file includes both players' names and account details and the in-game chat. Only share your archive if you're comfortable with that.",
    },
  ],
  related: ["game-page", "public-profile", "my-game-didnt-show-up", "analyzer-filters"],
};

export default article;
