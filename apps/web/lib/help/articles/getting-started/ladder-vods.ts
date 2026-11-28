import type { HelpArticle } from "@/lib/help/types";

const article: HelpArticle = {
  slug: "ladder-vods",
  title: "Find a ladder game with a VOD",
  summary: "Search recent ladder games that a streamer recorded, by matchup, rating, length and map, and open the Twitch VOD at the start of the game.",
  category: "getting-started",
  audience: "all",
  signedInOnly: false,
  order: 34,
  keywords: ["ladder vods", "vod", "twitch", "replay", "matchup", "rating", "map", "game length", "watch games"],
  updated: "2026-11-28",
  related: ["live-streams", "getting-started"],
  body: [
    { type: "heading", text: "Search", anchor: "search" },
    { type: "paragraph", text: "Open [Ladder VODs](/ladder-vods). You don't need an account. The page starts with Terran vs Zerg at 5,000 to 5,999 rating (on a phone, length and map are under **More filters**). Change any menu and select **Search**; **Clear filters** sets every menu to any." },
    { type: "steps", items: [
      "Choose a **Matchup**. The streamer's race is shown first on each result.",
      "Choose a **Rating** band. The rating on a result is the streamer's, rounded to the nearest 100.",
      "Choose a **Length** and a **Map** if you want to narrow it down.",
      "Select a result to open the streamer's Twitch VOD in a new tab at the start of that game. Select **Show more games** for the next ten.",
    ] },
    { type: "heading", text: "What a result shows", anchor: "result" },
    { type: "paragraph", text: "Each result shows both races, the streamer's rating, the map, how long the game ran, how long ago it was played and the streamer's Twitch channel. It never names the other player. A **Subscribers only** label means Twitch shows that VOD to the channel's subscribers." },
    { type: "heading", text: "How fresh it is", anchor: "freshness" },
    { type: "paragraph", text: "Games and VOD links come from SC2Pulse. SC2 Tools keeps each search for a few minutes, so your browser never contacts SC2Pulse from this page. If a search can't be loaded you will see **Retry search**. A VOD can be removed by the streamer after it was listed." },
    { type: "heading", text: "If the page says it is not available yet", anchor: "not-available" },
    { type: "paragraph", text: "The finder opens once SC2Pulse has agreed to this use. Until then the page says so and sends nothing to SC2Pulse. [Live streams](/live) shows who is playing right now." },
  ],
};

export default article;
