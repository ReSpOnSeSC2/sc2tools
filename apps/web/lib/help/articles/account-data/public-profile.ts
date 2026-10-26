import type { HelpArticle } from "@/lib/help/types";

const article: HelpArticle = {
  slug: "public-profile",
  title: "Your public player page",
  summary:
    "Choose a public player link, control its sections, and create a channel panel. Profile visibility and replay sharing are separate choices.",
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
    "channel panel",
    "MMR history",
    "season record",
    "player link",
  ],
  updated: "2026-10-25",
  body: [
    {
      type: "paragraph",
      text: "Your games, stats and opponents are private by default. There are two pages you can choose to make public, and each one is off until you turn it on.",
    },
    { type: "heading", text: "Public profile", anchor: "profile" },
    {
      type: "paragraph",
      text: "Your public page lives at `sc2tools.com/players/` followed by a player link. Its Overview shows your record, matchup splits and replay-detected signature builds. Builds and Reviews tabs appear when you have public content; a Replays tab appears only when replay sharing is on and you choose to link it.",
    },
    {
      type: "list",
      items: [
        "**Base profile:** the public author name you chose, or your display name when you have no named publication; your main race, games, wins, losses, win rate, results against each race, most-played replay-detected builds and a featured community build. Public reviewer stats have their own tab.",
        "**Optional sections, initially off:** approved channels, recent results by matchup, a weekly MMR history, cached season records and map records with at least 10 games. Recent form shows up to 20 results from oldest to newest, a streak from two results and last-played time. Its card needs at least three games and never includes opponent names or maps.",
        "**Never in profile aggregates:** your opponents' names, battle tags or IDs, private notes or email. Optional recent results contain only result, matchup and date. Full replay rows and downloads need the separate replay-sharing choice below.",
      ],
    },
    { type: "heading", text: "Turn it on or off", anchor: "turn-on" },
    {
      type: "steps",
      items: [
        "Open [Settings → Profile](/settings?tab=profile) → **Public player page**. If needed, choose **Create player link**. Creating an address keeps the profile and optional sections off.",
        "Choose **Public profile on**, select only the optional sections you want, then **Save public profile**. Preview the page and copy its link.",
        "To hide it, clear **Public profile on** and Save. That explicit Off choice wins even if named Community builds remain published. The build publications themselves are unchanged.",
        "Older accounts with a named published build keep their legacy profile until they save an explicit choice. Their new optional sections start off. Old profile and author links redirect directly to the canonical player address.",
      ],
    },
    { type: "heading", text: "Choose the player link", anchor: "player-link" },
    { type: "paragraph", text: "Edit the readable prefix in Settings; the fixed suffix keeps the address unique. Availability checks are advisory until Save. A link can be renamed once every 30 days, and an active shared replay archive must be turned off explicitly before renaming its shared address. Renaming changes the profile link; old renamed links are not retained as aliases." },
    { type: "heading", text: "Add a channel panel", anchor: "channel-panel" },
    { type: "paragraph", text: "In the Channel panel card choose Record, Featured build or MMR history, a theme and either 320 × 160 or 320 × 100. Copy the image URL and the panel destination link to your channel editor. The MMR style uses only an enabled MMR-history section. A disabled, private or temporarily unavailable profile always returns a neutral image. These are public panel links, separate from private overlay tokens." },
    { type: "paragraph", text: "Turning the profile off hides personal stats and makes the panel neutral when the page or image is next opened. It leaves your separate replay-sharing choice unchanged." },
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
    { type: "heading", text: "Shared game analysis", anchor: "shared-analysis" },
    {
      type: "paragraph",
      text: "Open **Analysis** from a replay row. **Back** returns to your filtered list, including its page. **Older game** and **Newer game** move within the same filters; the plain **← / →** keys do the same outside text fields and the timeline. At an end of the list, that direction is unavailable. Alt+← keeps its normal browser Back behavior.",
    },
    {
      type: "paragraph",
      text: "Use the section links for **Timeline**, **Macro**, **Build orders** and, when a recording is available, **Watch**. A macro leak's timestamp jumps the timeline to that point. **Show all** lists the scored leaks from highest penalty down. Macro scores are out of 100: **80+ good**, **60–79 OK**, and **below 60 leaky**; an unavailable score has a neutral colour.",
    },
  ],
  related: ["publish-community-builds", "replays", "player-channels", "delete-account"],
};

export default article;
