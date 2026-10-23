import type { HelpArticle } from "@/lib/help/types";

const article: HelpArticle = {
  slug: "repair-my-data",
  title: "Fixing wrong opponent counts",
  summary: "Recount opponents, check uploaded replay files or re-run saved custom-build matching without wiping your games.",
  category: "account-data",
  audience: "all",
  signedInOnly: true,
  keywords: ["repair", "opponent counts", "duplicate", "inflated", "recount", "rebuild", "archive", "missing replay", "custom build", "matching"],
  updated: "2026-10-23",
  order: 25,
  body: [
    { type: "paragraph", text: "Open [Settings → Backups & data](/settings?tab=backups) and find **Repair my data**. Each repair saves a Before action snapshot before changing derived records. Your existing game history stays in place." },
    { type: "heading", text: "Choose a repair", anchor: "choose" },
    { type: "table", head: ["Action", "What it does", "When to use it"], rows: [["Recount opponent records", "Rebuilds opponent totals from saved games and attempts missing opponent identity links", "Opponent game counts look inflated or out of date"], ["Re-check replay archive", "Checks already uploaded original replay files and clears stale availability markers", "A game claims an archived replay is available, but its download is missing"], ["Re-run custom-build matching", "Matches all saved games against your current saved build definitions using their available game details", "Build labels are stale after editing your definitions"]] },
    { type: "heading", text: "Wait for the result", anchor: "result" },
    { type: "steps", items: ["Press the relevant repair button once. **Repair started** means the backup succeeded and the repair was accepted.", "Wait for the result in your notification bell. If the repair fails, the notification links back to Backups & data.", "Each type of repair has a one-hour cooldown. A running import or another data action can also ask you to wait; finish it before retrying."] },
    { type: "callout", tone: "info", title: "A re-check cannot recreate a missing file", text: "If a replay or its details were deleted, keep the local SC2Replay file and click Re-sync in the desktop app. An archive re-check only verifies files already uploaded." },
    { type: "paragraph", text: "If backup storage is unavailable, the repair does not start. For persistent errors, use [Report a problem](/help/report-a-problem) with your diagnostics. Avoid wiping history just to fix opponent totals." },
  ],
  related: ["backups-and-export", "install-and-pair", "report-a-problem"],
};
export default article;
