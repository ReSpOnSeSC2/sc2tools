import type { HelpArticle } from "@/lib/help/types";

const article: HelpArticle = {
  slug: "match-rooms",
  title: "Run and score a series in Match Rooms",
  summary: "Invite two players, run the map veto and score a StarCraft II series manually or from replays.",
  category: "getting-started",
  audience: "player",
  signedInOnly: false,
  order: 32,
  keywords: ["match rooms", "veto", "maps", "series", "best of", "replay score"],
  updated: "2026-11-13",
  related: ["getting-started"],
  body: [
    { type: "heading", text: "Create and invite", anchor: "create" },
    { type: "paragraph", text: "Open [Match Rooms](/match) and pick a best-of format and veto preset. Start with the ladder maps or enter your own map list. Create a room to invite two players, or practice both seats by yourself." },
    { type: "paragraph", text: "Keep the host link. Send a different seat link to each player and give spectators the watch link. Anyone with a link can use its role. Names entered by players are self-declared." },
    { type: "heading", text: "Run the veto and score the match", anchor: "play" },
    { type: "paragraph", text: "Both seats ready up. A coin flip picks the first seat, then the players alternate turns. If a 30-second timer runs out, the room chooses an eligible map and advances." },
    { type: "paragraph", text: "The host or either player can record the winner of each game. The host can undo the last score immediately. A player can request the undo and the other player can agree." },
    { type: "heading", text: "Report a score from replay", anchor: "replay" },
    { type: "paragraph", text: "Open your seat link. Choose or drop one completed one-on-one .SC2Replay for the next map and select your name. The first report matches the two players to the seats for this room. Your file and the names stay in your browser." },
    { type: "paragraph", text: "Ask the other player to report the same game from their seat link, even after the series ends. A matching report marks the score confirmed by both players. These are player reports. SC2 Tools does not verify the replay itself." },
    { type: "paragraph", text: "If the room rejects the replay, check the map order, selected player, and when the game ended. Use manual scoring for older rooms, practice rooms or a replay the browser cannot read." },
    { type: "paragraph", text: "After the match, copy the score for Discord or Reddit, or share an image with neutral seat labels." },
    { type: "paragraph", text: "A room expires 14 days after creation. The host can delete it immediately from the room page." },
  ],
};

export default article;
