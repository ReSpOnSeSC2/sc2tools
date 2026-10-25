import type { HelpArticle } from "@/lib/help/types";

const article: HelpArticle = {
  slug: "filter-by-account", title: "Filter by account", category: "analyzer", audience: "player", signedInOnly: true,
  summary: "Keep one or more of your Battle.net accounts in the analyzer's shared scope.",
  keywords: ["account", "main", "alt", "smurf", "toon", "EU", "region", "filters"], updated: "2026-10-25",
  body: [
    { type: "steps", items: ["Open Filters in the analyzer's filter bar.", "Open Account and select the Battle.net accounts you want to count. Labels show the available name, region and league; the exact handle appears underneath.", "Keep using date, region, matchup and other filters to narrow those accounts further. Choose All accounts, remove the Accounts chip, or reset the filters to clear the account selection."] },
    { type: "paragraph", text: "The picker appears when your library has more than one account. If an active selection is no longer in the account list, its exact handle remains available to clear. Account labels are best effort; a missing name or rating does not change which replays belong to the selection." },
    { type: "paragraph", text: "You can select up to 20 literal Battle.net account handles. A region filter still intersects this selection. Choosing All accounts includes every account in your signed-in library; it does not include other users' uploads." },
    { type: "paragraph", text: "The selection applies to filter-aware analyzer pages and CSV export. Today cards that use their own scope keep that scope. Individual replay pages still describe that replay." },
    { type: "paragraph", text: "Use a saved view or copy a view link to reopen this exact account selection. Account handles are included in those links, so share them deliberately. Ordinary device filter storage does not remember account handles, and switching accounts or signing out clears the active selection." },
    { type: "callout", tone: "info", text: "If no games match, clear the Accounts chip or choose All accounts, then check your date and region filters. If account labels fail to load, retry without changing the active selection." },
  ], related: ["analyzer-filters", "export-csv"],
};
export default article;
