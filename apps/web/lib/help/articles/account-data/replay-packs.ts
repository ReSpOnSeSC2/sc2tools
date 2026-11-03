import type { HelpArticle } from "@/lib/help/types";

const article: HelpArticle = {
  slug: "replay-packs", title: "Private replay packs", summary: "Save up to 100 original replay files with useful filenames, a per-game manifest and clear partial results.",
  category: "account-data", audience: "player", signedInOnly: true, updated: "2026-11-03", order: 21,
  keywords: ["replay pack", "zip", "batch download", "100 replays", "SC2Replay", "manifest", "filename", "recorded result", "cancel download", "partial download", "original replay", "export"],
  body: [
    { type: "heading", text: "Choose games", anchor: "select" },
    { type: "steps", items: [
      "Open [Replays](/app/replays#replay-packs), set the global and replay filters, then choose **Replay pack**. Wait for the current list to finish updating before selecting.",
      "Use the row checkboxes to choose up to 100 games. You can move between pages while keeping the same filters. This pack selection never becomes the page's hide/delete selection.",
      "**Select matching (up to 100)** replaces your selection with the first 100 games in the current sort after the complete result arrives. It does not merge another 100 or follow later pages. Failed or cancelled selection leaves your current same-filter choices alone. Changing account or filters clears them; Clear pack selection removes them explicitly.",
      "Choose a filename option and press **Download replay pack**. If offered, choose a destination file. Otherwise the browser prepares a download only after the archive is complete.",
    ] },
    { type: "heading", text: "Filenames and recorded results", anchor: "filenames" },
    { type: "paragraph", text: "The descriptive option uses date, matchup and recorded result, then **vs opponent on map**. Known results are Win, Loss or Tie; missing or unrecognized results say Unknown. It uses the recorded list value and never derives a match result from download success. Date/opponent/map, date/matchup/map and Game ID options remain available. Unsafe filename characters are cleaned, long names shortened, collisions numbered and every original keeps .SC2Replay." },
    { type: "heading", text: "Progress and partial results", anchor: "results" },
    { type: "paragraph", text: "Files are retrieved in groups of up to four. Progress shows checked files, downloaded bytes and archive bytes actually written. A listed archive size is advisory; unknown sizes are shown separately and availability is checked at download time. Files that disappeared, changed or could not be completely retrieved are omitted. A completed partial pack shows how many originals were saved and how many were unavailable or failed." },
    { type: "paragraph", text: "The ZIP includes **manifest.csv** in selection order and **README.txt**. The manifest records safe selected game metadata, the recorded match result, each saved filename and a separate download status. It includes no temporary file URLs or account tokens. Only complete original files are marked saved. The README explains counts and privacy; an archive with no saved originals can still truthfully report every failed or unavailable selection." },
    { type: "heading", text: "Cancel and save limits", anchor: "cancel" },
    { type: "paragraph", text: "**Cancel replay pack** stops that job, and a cancelled pack does not automatically save a partial ZIP. Wait for actual network and file cleanup before another export; cancelling the local request cannot confirm remote cleanup has finished. A storage or output failure also stops the archive. Cancellation cannot instantly undo bytes already committed by a browser's direct file writer." },
    { type: "paragraph", text: "A direct destination file supports streaming larger packs. The fallback keeps a completed archive in memory up to 128 MiB; use fewer games if the limit is reached. Originals are bounded to 5 MiB each. Account archives, build orders and replay packs share one browser export slot. Unstarted expired links may be refreshed once; failed downloads and busy/rate errors do not retry automatically. The pack reads selected records and originals in sequence, so concurrent changes can affect availability." },
    { type: "callout", tone: "warning", title: "Keep originals private", text: "Original .SC2Replay files can contain player and account identifiers, chat, team information and other embedded data. A pack is not anonymized, a redacted support bundle or a restorable account snapshot. Review the archive before sharing. Temporary links already issued can remain usable until their one-minute expiry after cancellation, deletion or unlinking." },
    { type: "heading", text: "If files cannot be retrieved", anchor: "access" },
    { type: "paragraph", text: "Try a smaller selection or try again later. A general browser connection error cannot identify its cause. Operators must verify browser GET access for the deployed site origin before announcing replay-pack availability; successful desktop uploads or individual link downloads do not prove that browser access is configured. See [Backups and export](/help/backups-and-export#export) for the other export formats." },
  ],
  related: ["replays", "backups-and-export", "export-csv", "my-game-didnt-show-up"],
};
export default article;
