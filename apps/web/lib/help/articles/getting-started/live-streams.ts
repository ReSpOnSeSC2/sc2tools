import type { HelpArticle } from "@/lib/help/types";

const article: HelpArticle = {
  slug: "live-streams",
  title: "Find a live StarCraft II stream",
  summary: "See every StarCraft II channel that is live now on Twitch and Kick, filter by platform and language, and find small channels first.",
  category: "getting-started",
  audience: "all",
  signedInOnly: false,
  order: 33,
  keywords: ["live streams", "twitch", "kick", "watch", "streamers", "viewers", "language", "small channels"],
  updated: "2026-11-27",
  related: ["getting-started"],
  body: [
    { type: "heading", text: "Open the list", anchor: "open" },
    { type: "paragraph", text: "Open [Live streams](/live) from the Tools page. You don't need an account. Each card shows the stream title, the channel, the platform, the language and the number of viewers. Select a card to open that channel on Twitch or Kick in a new tab. SC2 Tools doesn't embed players." },
    { type: "heading", text: "Filter and order", anchor: "filter" },
    { type: "steps", items: [
      "Use **Platform** to show Twitch or Kick channels only.",
      "Use **Language** to show one language. The number beside each language is how many channels use it right now.",
      "Choose **Most viewers** to see the busiest channels first, or **Small channels first** to find someone with few viewers who would notice a new one.",
    ] },
    { type: "heading", text: "How fresh the list is", anchor: "freshness" },
    { type: "paragraph", text: "SC2 Tools asks Twitch and Kick for the list about once a minute and shows everyone the same copy, so your browser never contacts either platform from this page. The page checks again by itself while it is open and shows when the list was updated." },
    { type: "paragraph", text: "If one platform can't be reached, the page says so and keeps its last list for up to ten minutes. If the whole list is unavailable you will see **Retry live streams**. An empty list means no StarCraft II channel is live on the platforms that are switched on." },
    { type: "paragraph", text: "Titles and channel names are written by the streamers and are shown as they wrote them." },
  ],
};

export default article;
