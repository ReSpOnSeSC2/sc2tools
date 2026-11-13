import type { HelpArticle } from "@/lib/help/types";

const article: HelpArticle = {
  slug: "sc2-daily",
  title: "Call the fight in SC2 Daily",
  summary: "Pick who trades better in five StarCraft II fights, see the resource losses, and keep a streak on this device.",
  category: "getting-started",
  audience: "player",
  signedInOnly: false,
  order: 31,
  keywords: ["daily", "arcade", "fight", "trade", "streak"],
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
  ],
};

export default article;
