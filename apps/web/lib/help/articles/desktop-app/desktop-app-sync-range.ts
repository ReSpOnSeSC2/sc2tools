import type { HelpArticle } from "@/lib/help/types";

const article: HelpArticle = {
  slug: "desktop-app-sync-range",
  title: "Choose what the desktop app syncs",
  summary: "Limit a large replay library to the current season or a custom date range, then widen it when you want older games.",
  category: "desktop-app",
  audience: "player",
  keywords: ["sync range", "current season", "queued uploads", "older replays", "custom range"],
  updated: "2026-10-23",
  order: 20,
  body: [
    { type: "paragraph", text: "If your PC has years of replays, start with **Current season** so recent games sync first. The desktop app's range controls what it uploads; the website's analyzer filters only control what you see." },
    { type: "heading", text: "Pick a range", anchor: "choose-range" },
    { type: "steps", items: [
      "Open the desktop app's **Settings** page and find **Sync date range**.",
      "Choose **Current season**, a season, **All time**, or **Custom range** with its start and end dates.",
      "Press **Save settings**. The confirmation names the active range and, when relevant, how many queued uploads were skipped and how many older replays will sync again.",
    ] },
    { type: "paragraph", text: "Changing the range skips queued uploads outside it immediately. It does not delete replays from your PC or remove games already in your account. Widen the range later to include older games; the app scans the watched folders again." },
    { type: "paragraph", text: "A game still missing inside the range may be in an unwatched folder. See [Replay folders](/help/replay-folders) and [My game didn't show up](/help/my-game-didnt-show-up)." },
  ],
  related: ["desktop-app-overview", "replay-folders", "my-game-didnt-show-up", "analyzer-filters"],
};

export default article;
