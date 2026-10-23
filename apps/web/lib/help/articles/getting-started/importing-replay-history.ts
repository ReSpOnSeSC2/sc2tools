import type { HelpArticle } from "@/lib/help/types";

const article: HelpArticle = {
  slug: "importing-replay-history", title: "Importing your replay history", summary: "Start a desktop import, read its outcome, or import files in your browser.", category: "getting-started", audience: "player", signedInOnly: true,
  keywords: ["import", "history", "replay", "scan", "folder", "cancel", "skipped", "date range", "failed", "browser"], updated: "2026-10-23",
  body: [
    { type: "paragraph", text: "Open [Settings → Import](/settings?tab=import). Desktop import is available to every signed-in player. Browser import appears when Instant Analysis is enabled for your account." },
    { type: "steps", items: [
      "**Link and open the app.** [Pair SC2 Tools](/devices) on your gaming PC. If it is offline, start it there before sending import commands.",
      "**Start full import** reads the folders the desktop app watches. **Re-scan only** checks them again; **Choose a replay folder** opens a folder picker on that PC.",
      "**Watch progress.** Files are checked locally, then their results sync to your account. Imports can keep running while you use the website.",
      "**Read Recent jobs.** Your last ten runs show counts, status, when they started and how long they took. Expand **Files that couldn't be imported** to see the reasons.",
      "**Restart if needed.** Cancelling keeps games already imported. Start again from Settings → Import when ready; the service recognizes existing games instead of adding duplicates.",
    ] },
    { type: "paragraph", text: "Skipped reasons are different from corrupt files: **game vs the AI**, **replay-resume session**, and **outside your import date range** are intentional exclusions. A missing player identity needs a profile correction. For parsing or analysis failures, update the desktop app and retry; [Why didn't my game show up?](/help/my-game-didnt-show-up) explains the other outcomes." },
    { type: "paragraph", text: "Browser import analyzes selected files in this tab and uploads the results. Keep it open until processing finishes. Folder Sync is available in supported browsers; private replay-file backups depend on the backup option and server availability. [Browser import](/help/browser-import) covers those controls." },
  ], related: ["setup-health", "install-and-pair", "browser-import", "my-game-didnt-show-up"],
};
export default article;
