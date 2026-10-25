import type { HelpArticle } from "@/lib/help/types";

const article: HelpArticle = {
  slug: "desktop-app-import",
  title: "Importing your replay history",
  summary: "Follow replay-history progress, choose a season, and understand why a file was skipped or can be retried.",
  category: "desktop-app",
  audience: "all",
  keywords: ["import", "history", "backfill", "waiting", "ETA", "skipped", "player unresolved", "filtered", "re-sync"],
  updated: "2026-10-23",
  body: [
    { type: "paragraph", text: "After linking your PC, the app scans watched replay folders and imports eligible files in the background. **Importing your replay history** on the Dashboard shows counts and phase. Live games keep their existing priority while history waits during play according to your background-sync settings." },
    { type: "heading", text: "Read the progress card", anchor: "progress" },
    { type: "table", head: ["Phase", "Meaning"], rows: [
      ["Scanning", "Counting eligible files off the window thread. An unavailable inventory stays unknown; it does not claim there are zero files."],
      ["Importing", "The counts show completed outcomes against the current inventory. New files can increase that inventory. Throughput uses a five-minute moving average; ETA appears only after enough measured samples."],
      ["Paused", "You paused syncing. The rate and ETA are hidden until syncing resumes."],
      ["Waiting for connection", "Replays remain queued while the connection recovers. Rate and ETA are hidden. Retry now is available on the status card."],
      ["Done", "The latest inventory confirms nothing eligible remains. Skipped or rejected outcomes can still need attention in Recent games."],
    ] },
    { type: "steps", items: [
      "Use **Pause** or **Resume** on the card to control syncing.",
      "Choose **Only import this season** to apply just the saved Current season filter. It does not save unrelated edits in Settings. Files outside that range remain on your PC.",
      "Choose **View on website** to open your dashboard. If you need a full Re-sync, use **Settings → Maintenance → Re-sync replay library…** and confirm. Its progress uses this same card, including when cloud progress reporting is offline.",
    ] },
    { type: "heading", text: "Skipped replay reasons", anchor: "skipped" },
    { type: "paragraph", text: "Open **Recent games → Skipped**. New local outcomes have a timestamp; older stored markers have an unknown date and appear only under **All dates**. Those markers are grouped by cause and do not count as games played today." },
    { type: "table", head: ["Reason", "What to do", "Retry these?"], rows: [
      ["We couldn't tell which player was you (player_unresolved)", "Set your player name in Settings, save it, then retry.", "Yes"],
      ["This replay could not be analyzed (parse_failed)", "Check that it is a readable SC2Replay file and check for an agent update.", "Yes"],
      ["StarCraft II was still saving this replay (file_unstable)", "Wait for the file to finish writing, then retry.", "Yes"],
      ["Outside your selected sync range (filtered)", "Review the saved date range. Retry still respects that filter; change the range first if needed.", "Yes"],
      ["A game against the computer (ai_game)", "Supported player matches are synced. Repeating the same file does not change its participants.", "No"],
      ["Take Command or resumed replay (resumed_replay)", "Synthetic/resumed results are excluded from ordinary game records.", "No"],
      ["No final result (no_result)", "A completed match with a recorded result is needed.", "No"],
      ["Analysis stopped (analysis_failed)", "Check the Activity log for the file's error and agent updates before explicitly re-analyzing that file.", "No group retry"],
      ["Detailed playback exceeded its resource limit (playback_budget_exceeded)", "Review Map replay capture in Settings and the Activity log. Resource limits protect your PC.", "No group retry"],
      ["Unsupported replay format (unsupported_replay)", "Check for an agent update. Some formats remain unsupported.", "No"],
    ] },
    { type: "callout", tone: "info", title: "Retry only the files you choose", text: "**Retry these** clears markers for that one retryable reason, leaving unrelated uploads intact. Missing files and files already queued are left alone. The normal watcher and saved date filter handle the retry; no file is deleted or renamed." },
    { type: "paragraph", text: "For an upload failure, right-click a row for **Retry**, **Copy error** or Help; select failed rows for **Retry failed**. [Your recent games](/help/desktop-app-recent-games) explains game rows and local totals. All analysis uses fixed replay rules; no AI or model API is involved." },
  ],
  related: ["desktop-app-recent-games", "desktop-app-sync-range", "replay-folders", "desktop-app-sync-problems"],
};

export default article;
