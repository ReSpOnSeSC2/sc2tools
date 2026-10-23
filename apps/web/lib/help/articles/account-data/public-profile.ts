import type { HelpArticle } from "@/lib/help/types";

const article: HelpArticle = {
  slug: "public-profile",
  title: "Your public profile and replay page",
  summary:
    "The two pages anyone can see about you, both off until you turn them on: your public profile with your record and signature builds, and your shared replay archive.",
  category: "account-data",
  audience: "all",
  signedInOnly: true,
  order: 40,
  keywords: [
    "public profile",
    "player page",
    "profile link",
    "share profile",
    "signature builds",
    "featured build",
    "author name",
    "anonymous",
    "replay page",
    "share replays",
    "private",
    "privacy",
    "turn off",
  ],
  updated: "2026-10-23",
  body: [
    {
      type: "paragraph",
      text: "Your games, stats and opponents are private by default. There are two pages you can choose to make public, and each one is off until you turn it on.",
    },
    { type: "heading", text: "Public profile", anchor: "profile" },
    {
      type: "paragraph",
      text: "A shareable page with your record, matchup splits and signature builds, at an address like `sc2tools.com/p/` followed by your ID.",
    },
    {
      type: "list",
      items: [
        "**Shown:** the author name you chose, your main race, your games, wins, losses and win rate, your results against each race, your most-played builds with their win rates, a featured community build, and your reviewer stats if you write replay reviews.",
        "**Never shown:** your opponents' names, battle tags or IDs, your individual games, your notes, or your email.",
      ],
    },
    { type: "heading", text: "Turn it on or off", anchor: "turn-on" },
    {
      type: "steps",
      items: [
        "Your profile turns on when you publish a build to [Community](/community) under a public author name. Open one of your [custom builds](/builds), choose **Publish**, and leave **Post anonymously** unticked. See [Publish and reuse community builds](/help/publish-community-builds).",
        "[Settings → Profile](/settings?tab=profile) then shows *Your profile is live*, with **View profile** and **Copy link**.",
        "To turn it off, take down your named community builds, or publish them anonymously instead. With no build under your name, the page goes away.",
      ],
    },
    { type: "heading", text: "Shared replay page", anchor: "replay-page" },
    {
      type: "paragraph",
      text: "Separately, you can share your whole replay archive from [Replays](/app/replays) with **Share replay page**. Visitors see every synced game with its map, result, players, MMR, builds and stream links, and can download your original replay files. Turn it off there at any time. See [Replays](/help/replays).",
    },
    {
      type: "callout",
      tone: "info",
      title: "Opponents have a public page too",
      text: "An opponent faced by at least 5 SC2 Tools players gets a combined public profile with no names. Your games add to it without naming you. See [Opponent dossier](/help/opponent-dossier).",
    },
    { type: "heading", text: "Finding a game", anchor: "finding-a-game" },
    {
      type: "paragraph",
      text: "Replay filters combine and apply as soon as you change them. Search applies after you pause with at least two characters, or immediately when you press Enter. Without JavaScript, choose **Apply**. Matchup and map choices come from the player's archive. Each chip removes one filter; **Clear all** removes them together. **This season**, **Last 7 days** and **Last 30 days** roll forward when you open the link.",
    },
    {
      type: "paragraph",
      text: "The record line counts all games matching the active filters, across every page. A result filter hides the win–loss record and win rate so a list of losses does not look like an overall record. Copy the page URL or choose **Share** to share the same filtered view. **Older replays** moves back in time; when sorted oldest first, **Newer replays** moves forward.",
    },
    { type: "heading", text: "What visitors can see", anchor: "what-visitors-can-see" },
    {
      type: "paragraph",
      text: "The replay list and downloads need no account. Full analysis — the timeline, macro breakdown and both build orders — needs a free account. Downloads are the original .SC2Replay file, which includes the in-game names and chat StarCraft II records.",
    },
  ],
  related: ["publish-community-builds", "replays", "player-channels", "delete-account"],
};

export default article;
