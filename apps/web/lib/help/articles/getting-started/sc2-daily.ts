import type { HelpArticle } from "@/lib/help/types";

const article: HelpArticle = {
  slug: "sc2-daily",
  title: "Call the fight in SC2 Daily",
  summary: "Pick who trades better in five StarCraft II fights, see the resource losses, and keep a streak on this device.",
  category: "getting-started",
  audience: "player",
  signedInOnly: false,
  order: 31,
  keywords: ["daily", "arcade", "fight", "trade", "streak", "scout", "openings"],
  updated: "2026-11-13",
  related: ["arcade", "getting-started"],
  body: [
    { type: "heading", text: "Play five fights", anchor: "play" },
    { type: "paragraph", text: "Open [SC2 Daily](/arcade). Each clip starts one second before contact. Blue and Red show the two armies. Choose one of the five calls, from Blue wins big to Red wins big." },
    { type: "paragraph", text: "After your call, watch the fight or skip to the result. The result compares the minerals and gas invested in the units each side lost. A roughly even trade has a ratio from 0.8 to 1.25. A side wins big when its opponent loses more than 2.5 times as many resources." },
    { type: "heading", text: "Keep a streak and share your score", anchor: "share" },
    { type: "paragraph", text: "Everyone gets the same set for the UTC day. When a recorded set is unavailable, the practice week rotates through sample fights. Recorded sets and practice sets have separate streaks." },
    { type: "paragraph", text: "Completing all five fights saves your score and streak in this browser. Copy your result to share your score without revealing the answers." },
    { type: "heading", text: "See how the crowd called each fight", anchor: "crowd" },
    { type: "paragraph", text: "After finishing today's five recorded fights, choose See crowd split to send your calls anonymously. The split appears at 20 votes. You can check again before midnight UTC without adding another vote. Practice sets keep your calls on this device." },
    { type: "paragraph", text: "Copy a fight link to let someone play that recorded fight before seeing the result. Playing one shared fight leaves the daily score and streak unchanged." },
    { type: "heading", text: "Identify the opening in Daily Scout", anchor: "scout" },
    { type: "paragraph", text: "Open [Daily Scout](/arcade/scout). Drag the game-time slider or use its arrow keys to see when each structure appeared. Select a building in the timeline to bring its marker to the front and see its exact grid position. Pick a strategy to reveal the answer, then move to the next opening." },
    { type: "paragraph", text: "Daily Scout rotates a practice week of sample openings until a Tracker set is scheduled. Tracker sets use building placements from reviewed replays. Play all five openings to save a score and streak in this browser. Copy a result without giving away the answers." },
  ],
};

export default article;
