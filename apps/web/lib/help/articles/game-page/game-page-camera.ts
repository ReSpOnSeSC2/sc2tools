import type { HelpArticle } from "@/lib/help/types";

const article: HelpArticle = {
  slug: "game-page-camera",
  title: "Follow camera and attention",
  summary: "Follow either player's recorded camera and see where they looked before a fight.",
  category: "game-page",
  audience: "player",
  signedInOnly: true,
  order: 6,
  keywords: ["replay", "follow camera and attention"],
  updated: "2026-11-11",
  body: [
    { type: "steps", items: [
      "Open Map replay on the game page and open Replay settings.",
      "Under Camera, choose Follow you or Follow opponent. The other player's recorded camera appears as a faint rectangle. Drag the map to return to Free camera.",
      "Open Camera attention beneath the replay. Pick a player to see camera density, time near the army and town halls, and the five-second lookback before each fight.",
    ] },
    { type: "paragraph", text: "On sectioned recordings, the attention card starts with the loaded section. Choose **Analyze full replay** when available to include every section and the five seconds across section boundaries. Very large recordings show section results. The two percentages can overlap." },
    { type: "paragraph", text: "If camera data is unavailable, update the desktop app and open Settings → Backups & data. Choose **Add camera data** under Re-analyze games." },
  ],
  related: ["game-page", "game-page-replay", "game-page-accurate-playback"],
};

export default article;
