import type { HelpArticle } from "@/lib/help/types";

const article: HelpArticle = {
  slug: "hotkey-habits",
  title: "Hotkey and camera habits",
  summary: "Read control-group use, camera saves and screen switching from the replay.",
  category: "game-page",
  audience: "player",
  signedInOnly: true,
  order: 7,
  keywords: ["replay", "hotkey and camera habits"],
  updated: "2026-11-11",
  body: [
    { type: "steps", items: [
      "Open your game page and choose Hotkeys in the Mechanics card.",
      "Select Whole game or a game phase to see control-group sets and recalls, saved camera locations, camera returns, and selection and queued-command rates.",
      "In Macro, choose Groups used or Camera returns in Mechanics progress to compare your measured games over time.",
    ] },
    { type: "paragraph", text: "These are logical actions recorded in the replay. Camera returns are inferred when the view moves to a uniquely saved location." },
    { type: "paragraph", text: "For an older game, update the desktop app and re-analyze it from Settings → Backups & data." },
  ],
  related: ["game-page", "game-page-replay", "game-page-accurate-playback"],
};

export default article;
