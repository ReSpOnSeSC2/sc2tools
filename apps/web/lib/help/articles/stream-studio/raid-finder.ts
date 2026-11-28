import type { HelpArticle } from "@/lib/help/types";

const article: HelpArticle = {
  slug: "raid-finder",
  title: "Raid finder (raid a live StarCraft II channel)",
  summary:
    "When you pick Stream ending in the Stream Dock, see live StarCraft II channels worth raiding, smallest first, and start a Twitch raid in one confirmed click.",
  category: "stream-studio",
  audience: "streamer",
  signedInOnly: true,
  order: 16,
  keywords: ["raid", "raids", "stream ending", "outro", "twitch raid", "cancel raid", "live channels", "small streamers"],
  updated: "2026-11-28",
  related: ["stream-dock", "viewer-engagement"],
  body: [
    {
      type: "paragraph",
      text: "Pick **Stream ending** in the Stream Dock's Scenes section and a **Raid a channel** panel opens under the scene buttons. It lists the StarCraft II channels that are live on Twitch and Kick right now, from the same list as the public Live Streams page, so it never calls a provider from your browser.",
    },
    { type: "heading", text: "How channels are ordered", anchor: "ordering" },
    {
      type: "list",
      items: [
        "**Small channels first**: 20 viewers or fewer, smallest first, because a raid helps them most.",
        "**Channels you have raided, or that raided you**, newest first. A raid that was cancelled, refused or never confirmed does not count.",
        "**Everyone else**, smallest first.",
        "Your own channel never appears.",
      ],
    },
    { type: "heading", text: "Starting and cancelling a raid", anchor: "start-cancel" },
    {
      type: "steps",
      items: [
        "Press **Start raid** next to a Twitch channel and confirm. Twitch accepts the request and counts down 90 seconds.",
        "The Dock shows **Queued**, not done. Twitch does not report back when a queued raid goes, so the history keeps saying Queued.",
        "Press **Cancel raid** and confirm to stop it before the countdown ends. The Dock shows Twitch's answer in place, including when Twitch has no raid left to cancel.",
      ],
    },
    {
      type: "callout",
      tone: "info",
      title: "If Twitch does not answer clearly",
      text: "A raid that Twitch did not confirm is recorded as **Not confirmed** and is never sent a second time for you. Check Twitch before you try again. Twitch allows 10 raid requests every 10 minutes.",
    },
    { type: "heading", text: "Set it up", anchor: "setup" },
    {
      type: "paragraph",
      text: "Raids need their own Twitch permission, and they start off. In Settings, **Connect raids** asks Twitch for the raid permission only; it does not change your other connections. Then turn on **Allow raids from the Stream Dock**. Without the permission or the switch the list still shows, with links to each channel.",
    },
    { type: "settingsLink", label: "Open Twitch raid settings", href: "/settings?tab=chat#twitch-raids" },
    {
      type: "paragraph",
      text: "Kick has no raid call, so Kick channels are listed with links only. While the switch is on, raids you receive are added to the **Raid history** in the Dock.",
    },
  ],
};

export default article;
