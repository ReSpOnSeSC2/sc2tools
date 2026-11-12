import type { HelpArticle } from "@/lib/help/types";

const article: HelpArticle = {
  slug: "match-rooms",
  title: "Run a map veto in Match Rooms",
  summary: "Choose a format, invite two players, run the veto and record a StarCraft II series score.",
  category: "getting-started",
  audience: "player",
  signedInOnly: false,
  order: 32,
  keywords: ["match rooms", "veto", "maps", "series", "best of"],
  updated: "2026-11-12",
  related: ["getting-started"],
  body: [
    { type: "heading", text: "Create and invite", anchor: "create" },
    { type: "paragraph", text: "Open [Match Rooms](/match) and pick a best-of format and veto preset. Start with the ladder maps or enter your own map list. Create a room to invite two players, or practice both seats by yourself." },
    { type: "paragraph", text: "Keep the host link. Send a different seat link to each player and give spectators the watch link. Anyone with a link can use its role. Names entered by players are self-declared." },
    { type: "heading", text: "Run the veto and score the match", anchor: "play" },
    { type: "paragraph", text: "Both seats ready up. A coin flip picks the first seat, then the players alternate turns. If a 30-second timer runs out, the room chooses an eligible map and advances." },
    { type: "paragraph", text: "The host or either player can record the winner of each game. The host can undo the last score. After the match, copy the score for Discord or Reddit, or share an image with neutral seat labels." },
    { type: "paragraph", text: "A room expires 14 days after creation. The host can delete it immediately from the room page." },
  ],
};

export default article;
