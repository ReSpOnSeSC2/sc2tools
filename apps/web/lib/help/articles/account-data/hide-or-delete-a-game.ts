import type { HelpArticle } from "@/lib/help/types";

const article: HelpArticle = {
  slug: "hide-or-delete-a-game", title: "Hide or delete a game", category: "account-data", audience: "player", signedInOnly: true,
  summary: "Remove a replay from your statistics, or permanently delete its cloud data.",
  keywords: ["hide", "unhide", "delete", "friend played", "disconnect", "replay", "hidden games"], updated: "2026-10-25",
  body: [
    { type: "heading", text: "Hide a game from statistics", anchor: "hide" },
    { type: "steps", items: ["Open a game and choose More game actions, or select replays in the Replay archive.", "Choose Hide from stats and a reason: friend played, disconnect or bug, off-race practice, or other.", "Confirm Hide from stats. Your own statistics and scouting history refresh. The replay and its analysis remain available to you."] },
    { type: "paragraph", text: "Hiding affects only your copy and contribution. Another player who synced the same match keeps their own copy. Existing global benchmark and guide reference tables update on their normal recompute schedule; their displayed sample date still applies." },
    { type: "paragraph", text: "For privacy, hiding or deleting a game temporarily clears all current public guide examples from your sharing profile. Eligible examples can return after the next scheduled update." },
    { type: "steps", items: ["To restore a hidden game, open Settings → Backups & data → Hidden games.", "Choose Unhide. Its saved analysis and guide sample become eligible again, and the affected opponent record is recounted."] },
    { type: "heading", text: "Permanently delete a game", anchor: "delete" },
    { type: "paragraph", text: "Delete game removes the cloud game record, build orders and charts, original cloud replay, and playback artifacts. Active replay-review grants close; existing discussion text stays. Your original replay file on your computer is retained." },
    { type: "steps", items: ["Choose Delete game from the game's actions or the selected replay controls.", "Review the exact games and the list of cloud data that will be removed. Cancel is focused by default.", "Type the displayed confirmation exactly, then choose Delete. A bulk action processes at most the current page of 25 selected games, one at a time."] },
    { type: "paragraph", text: "A minimal owner-and-game deletion marker prevents the desktop or browser from re-importing the game. Restoring an older cloud snapshot cannot undo this deletion. Account-data exports include these deletion markers; full account erasure removes them." },
    { type: "heading", text: "If an action fails", anchor: "retry" },
    { type: "paragraph", text: "The status identifies completed games if a batch stops partway through. Retry the remaining games. Storage cleanup failures are shown as incomplete deletions in Hidden games; use Retry deletion there. A pending deletion cannot be unhidden. Changing the selected filters or account stops any remaining browser requests, while a request already accepted by the server may finish." },
  ], related: ["filter-by-account", "export-csv", "backups-and-export"],
};
export default article;
