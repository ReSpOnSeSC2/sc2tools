import type { HelpArticle } from "@/lib/help/types";

const article: HelpArticle = {
  slug: "desktop-stream-titles",
  title: "Stream titles",
  summary: "Show your current opponent and head-to-head record in stream titles, with optional refresh at game start or after syncing.",
  category: "desktop-app",
  audience: "all",
  order: 15,
  keywords: ["title", "stream", "Twitch", "Kick", "YouTube", "MMR", "tokens", "automatic", "quota", "opponent", "head-to-head", "map", "aka"],
  updated: "2026-11-06",
  body: [
    { type: "paragraph", text: "Open **Streams** in the desktop app. Connect the Twitch, Kick or YouTube accounts you want to control through SC2 Tools. Type a title and check its live preview. **Save title & description** explicitly applies the rendered title through your existing platform connections; YouTube also saves it for future sessions. Per-platform receipts distinguish verified titles from accepted requests whose readback is unavailable." },
    { type: "heading", text: "Add your own statistics", anchor: "tokens" },
    { type: "table", head: ["Token", "Value"], rows: [
      ["{mmr} / {league}", "Your session widget's current or last known rating and its league when available. No rating threshold is used to invent a league."],
      ["{record} / {wins} / {losses}", "Your synced session's decided results, such as 3W–2L. This uses the same inactivity-based session as the overlay."],
      ["{streak}", "The session's current consecutive win or loss streak when present, such as W3."],
      ["{peak}", "Highest recorded rating for the current character and race within the history sample."],
      ["{wr:PvZ}", "Decided-game matchup win rate. Replace PvZ with any Protoss/Terran/Zerg matchup, preserving the capitalization."],
      ["{opp} / {aka}", "The current live opponent and their known identity as (aka Name). The alias is empty when no different identity is known."],
      ["{race} / {map}", "Your race and the map when provided by the current live match. Ordinary ladder games may not report the map; a previous replay's map is never substituted."],
      ["{h2h} / {h2h_wr}", "Your confirmed wins and losses against the current opponent, such as 3W–2L and 60%. A known first meeting has a 0W–0L record and no invented win percentage. Unavailable history stays absent."],
    ] },
    { type: "paragraph", text: "For example: **SC2 ladder | {mmr} MMR | {record} | {wr:PvZ} PvZ**. Separate optional segments with **|**. An entire segment disappears when its statistics are unavailable. If the title exceeds 70 characters, trailing segments are removed whole. A single segment that is too long needs editing; words are never cut in half. The template can contain up to 500 characters." },
    { type: "paragraph", text: "Peak and matchup rates use at most the latest 512 recorded ladder games from the last 90 days. Peak uses one character and race in the current session region; it is not a lifetime peak. Matchup rates combine your recorded accounts. Missing statistics stay absent. **Refresh preview statistics** requests a private snapshot without publishing a title." },
    { type: "paragraph", text: "For a match title, enter your usual plain-text prefix and click **Use current-match template**. For example, **GM Protoss** becomes **GM Protoss | v {opp} {aka} | {h2h} ({h2h_wr}) | {map}**, rendering as **GM Protoss | v Barcode (aka Maru) | 3W–2L (60%) | Alcyone LE** when those details are known. The preset only edits the template; it does not enable automation or publish a title. Keep match tokens in optional segments so the title can return to your plain-text prefix outside a live match. To display a known 0W–0L record even without a percentage, put **{h2h}** and **{h2h_wr}** in separate optional segments." },
    { type: "heading", text: "Optional automatic refresh", anchor: "automatic" },
    { type: "list", items: [
      "Both automatic refresh options start off. Check **Refresh titles at the start of each game** for the current opponent, or **Refresh titles after each synced game** for post-game statistics. Choose the platforms, then click **Save automatic title settings**. Saving these settings never publishes a title.",
      "Twitch and Kick are selected initially. YouTube starts unselected because metadata updates consume its API quota. Select YouTube only if you want those updates.",
      "Game-start refresh runs once per live one-versus-one match after its current opponent is available. It does not wait for a replay upload or the post-sync ten-minute interval. Unknown aliases, maps and records stay absent, and a late response from a previous match cannot supply the next opponent's title.",
      "Post-game refresh waits for the live replay to finish syncing and runs at most once every ten minutes. Replays you watch, resumed replay branches and old imports do not trigger updates. Both refresh options run on a separate worker and send only changed titles.",
      "Turn off either checkbox and save to stop that kind of automatic request. Unpairing, changing the paired account or choosing advanced local account setup turns automatic refresh off; opt in again after reviewing the account and platform selection.",
    ] },
    { type: "paragraph", text: "If a platform request cannot be confirmed, check the platform and its receipt before retrying. The app remembers attempted titles across restarts and does not automatically repeat the same ambiguous request. The existing manual title save remains available. Automatic titles require SC2 Tools connections and a server that supports the private session endpoint." },
  ],
  related: ["desktop-app-overview", "obs-overlay-setup", "obs-auto-scene-switching"],
};

export default article;
