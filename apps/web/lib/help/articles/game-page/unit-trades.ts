import type { HelpArticle } from "@/lib/help/types";

const article: HelpArticle = {
  slug: "unit-trades",
  title: "Unit trades and lifespans",
  summary: "Compare which units dealt and took losses, and which matchups cost resources.",
  category: "game-page",
  audience: "player",
  signedInOnly: true,
  order: 8,
  keywords: ["replay", "unit trades and lifespans"],
  updated: "2026-11-11",
  body: [
    { type: "steps", items: [
      "Open Units next to Mechanics on your game page and choose You or Opponent.",
      "Expand a unit row to see what it killed and which units it died to. The Unattributed row collects credited kills without a known killing unit.",
      "Compare trade ratios only where both resource values are available. Median lifespan uses deaths with a recorded birth time.",
    ] },
    { type: "paragraph", text: "The build dossier and Macro show recent trade samples by matchup. Each card shows how many of the sampled replays contained measured details." },
    { type: "paragraph", text: "Build-order supply is shown as measured when a replay supply sample matches the step. An approximation uses the nearest earlier sample." },
    { type: "paragraph", text: "Update the desktop app and use Re-analysis in Settings → Backups & data to backfill eligible older games." },
  ],
  related: ["game-page", "game-page-replay", "game-page-accurate-playback"],
};

export default article;
