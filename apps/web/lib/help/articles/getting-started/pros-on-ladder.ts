import type { HelpArticle } from "@/lib/help/types";

const article: HelpArticle = {
  slug: "pros-on-ladder",
  title: "See who is playing on the Grandmaster ladder",
  summary: "A board of the Grandmasters who played a ladder game in the last hour, with known pros, their last games and a link when they stream.",
  category: "getting-started",
  audience: "all",
  signedInOnly: false,
  order: 35,
  keywords: ["pros", "grandmaster", "ladder", "playing now", "streaming", "live", "pro players", "last games"],
  updated: "2026-11-28",
  related: ["ladder-vods", "live-streams"],
  body: [
    { type: "heading", text: "What the board shows", anchor: "board" },
    { type: "paragraph", text: "Open [Pros on Ladder](/pros-on-ladder). You don't need an account. **Playing now** lists the Grandmasters who finished a 1v1 ladder game in the last hour, strongest first. Each tile shows the player's race, rating rounded to the nearest 100 and league. These players are not named, and no time is shown." },
    { type: "heading", text: "Pros", anchor: "pros" },
    { type: "paragraph", text: "When pro names are on, **Pros playing now** comes first. Each card shows the pro's nickname and team, race and rating, and their last games with the map, the other side's race, the result and how long ago. The other player is never named. A **Live** label and a **Watch live** link appear when the pro is streaming on Twitch or Kick." },
    { type: "heading", text: "How fresh it is", anchor: "freshness" },
    { type: "paragraph", text: "The data comes from SC2Pulse. SC2 Tools refreshes it every few minutes and the page asks for the newest copy every couple of minutes while it is open, so your browser never contacts SC2Pulse. If the board can't be loaded you will see **Retry**." },
    { type: "heading", text: "If the page says it is not available yet", anchor: "not-available" },
    { type: "paragraph", text: "The board opens once SC2Pulse has agreed to this use. Until then the page says so and sends nothing to SC2Pulse. [Live streams](/live) shows who is playing right now. To find a game with a VOD, use [Ladder VODs](/ladder-vods)." },
  ],
};

export default article;
