import type { HelpArticle } from "@/lib/help/types";

const article: HelpArticle = {
  slug: "dashboard-and-analyzer",
  title: "Dashboard & analyzer",
  summary:
    "What the analyzer shows from your replays: build win rates, map stats, opponent scouting, MMR progression and your custom build library.",
  category: "analyzer",
  audience: "player",
  keywords: [
    "stats",
    "dashboard",
    "win rate",
    "mmr",
    "maps",
    "veto",
    "opponents",
    "scouting",
    "head-to-head",
    "strategy detection",
    "opener",
    "custom builds",
  ],
  updated: "2026-10-22",
  body: [
    {
      type: "paragraph",
      text: "Everything is fed by your own replays — no manual tagging. The analyzer covers build win-rates (with MMR-band splits), map stats and veto help, opponent scouting (their openers, your head-to-head), MMR progression with peak/trough markers, and a custom build library you can save openings into. Strategy detection names the opener your opponent went for across 100+ known builds.",
    },
  ],
  related: ["analyzer-filters", "getting-started", "build-check-in"],
};

export default article;
