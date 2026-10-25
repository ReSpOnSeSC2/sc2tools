import type { HelpArticle } from "@/lib/help/types";
import columns from "../../../../../api/src/config/replayExportColumns.json";

const article: HelpArticle = {
  slug: "export-csv", title: "Export your games to a spreadsheet", category: "account-data", audience: "player", signedInOnly: true,
  summary: "Download the replays matching your current filters as an Excel-safe CSV file.",
  keywords: ["export", "CSV", "spreadsheet", "Excel", "columns", "download", "backup"], updated: "2026-10-25",
  body: [
    { type: "steps", items: ["Open Replays and choose your analyzer filters. The replay search, result, matchup and sort controls also apply.", "Select Export CSV. Stay signed in while the file is prepared.", "Open sc2tools-games.csv in your spreadsheet app. The download contains the first 50,000 matching games in your selected sort order (newest first by default)."] },
    { type: "paragraph", text: "The export includes your visible statistical library and follows the selected account, date, region and other filters. Hidden games and games marked for permanent deletion are excluded. A replay table page or cursor does not limit the export." },
    { type: "paragraph", text: "If the export reaches its 50,000-game cap, the download status says it was limited. Narrow the date range and export the remaining period separately. Exports are limited to one per minute for your signed-in account; wait a minute before retrying a rate-limit message." },
    { type: "paragraph", text: "The server writes UTF-8 with a byte-order mark so Excel recognizes names correctly. Cells beginning with formula characters are prefixed with an apostrophe. Missing values remain empty. This file contains replay statistics, not original replay files or a full account backup." },
    { type: "heading", text: "Column dictionary", anchor: "columns" },
    { type: "table", head: ["Column", "Meaning"], rows: columns.map(column => [column.key, column.description]) },
    { type: "paragraph", text: "Private game links require sign-in and ownership. Changing filters, switching accounts or signing out cancels a pending export. If the download fails, try a smaller date range or retry when the connection is restored." },
  ], related: ["analyzer-filters", "filter-by-account"],
};
export default article;
