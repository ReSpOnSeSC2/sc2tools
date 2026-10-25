import type { HelpArticle } from "@/lib/help/types";

const article: HelpArticle = {
  slug: "desktop-stream-titles",
  title: "Stream titles",
  summary: "Preview stream titles with your synced statistics and optionally refresh selected connected platforms after games.",
  category: "desktop-app",
  audience: "all",
  order: 15,
  keywords: ["title", "stream", "Twitch", "Kick", "YouTube", "MMR", "tokens", "automatic", "quota"],
  updated: "2026-10-24",
  body: [
    { type: "paragraph", text: "Open **Streams** in the desktop app. Connect the Twitch, Kick or YouTube accounts you want to control through SC2 Tools. Type a title and check its live preview. **Save title & description** explicitly applies the rendered title through your existing platform connections; YouTube also saves it for future sessions. Per-platform receipts distinguish verified titles from accepted requests whose readback is unavailable." },
    { type: "heading", text: "Add your own statistics", anchor: "tokens" },
    { type: "table", head: ["Token", "Value"], rows: [
      ["{mmr} / {league}", "Your session widget's current or last known rating and its league when available. No rating threshold is used to invent a league."],
      ["{record} / {wins} / {losses}", "Your synced session's decided results, such as 3W–2L. This uses the same inactivity-based session as the overlay."],
      ["{streak}", "The session's current consecutive win or loss streak when present, such as W3."],
      ["{peak}", "Highest recorded rating for the current character and race within the history sample."],
      ["{wr:PvZ}", "Decided-game matchup win rate. Replace PvZ with any Protoss/Terran/Zerg matchup, preserving the capitalization."],
    ] },
    { type: "paragraph", text: "For example: **SC2 ladder | {mmr} MMR | {record} | {wr:PvZ} PvZ**. Separate optional segments with **|**. An entire segment disappears when its statistics are unavailable. If the title exceeds 70 characters, trailing segments are removed whole. A single segment that is too long needs editing; words are never cut in half. The template can contain up to 500 characters." },
    { type: "paragraph", text: "Peak and matchup rates use at most the latest 512 recorded ladder games from the last 90 days. Peak uses one character and race in the current session region; it is not a lifetime peak. Matchup rates combine your recorded accounts. Missing statistics stay absent. **Refresh preview statistics** requests a private snapshot without publishing a title." },
    { type: "heading", text: "Optional automatic refresh", anchor: "automatic" },
    { type: "list", items: [
      "Automatic refresh starts off. Check **Refresh titles after each synced game**, choose the platforms, then click **Save automatic title settings**. Saving these settings never publishes a title.",
      "Twitch and Kick are selected initially. YouTube starts unselected because metadata updates consume its API quota. Select YouTube only if you want those updates.",
      "A real game-end event waits for its live replay to finish syncing. Replays you watch, resumed replay branches and old imports do not trigger updates. Updates run on a separate worker, at most once every ten minutes, and only when the rendered title changes.",
      "Turn off the checkbox and save to stop future automatic requests. Unpairing, changing the paired account or choosing advanced local account setup turns automatic refresh off; opt in again after reviewing the account and platform selection.",
    ] },
    { type: "paragraph", text: "If a platform request cannot be confirmed, check the platform and its receipt before retrying. The app remembers attempted titles across restarts and does not automatically repeat the same ambiguous request. The existing manual title save remains available. Automatic titles require SC2 Tools connections and a server that supports the private session endpoint." },
  ],
  related: ["desktop-app-overview", "obs-overlay-setup", "obs-auto-scene-switching"],
};

export default article;
