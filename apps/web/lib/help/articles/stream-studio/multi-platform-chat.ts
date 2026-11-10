import type { HelpArticle } from "@/lib/help/types";

const article: HelpArticle = {
  slug: "multi-platform-chat",
  title: "Multi-platform chat (Twitch · Kick · YouTube · TikTok)",
  summary:
    "Merge Twitch, Kick, YouTube and TikTok chat into one Browser Source, with alert sounds, chat read-aloud and on-device translation.",
  category: "stream-studio",
  audience: "streamer",
  signedInOnly: true,
  order: 2,
  keywords: [
    "multichat",
    "translate",
    "chat overlay",
    "twitch",
    "kick",
    "youtube",
    "tiktok",
    "chatroom id",
    "alert sounds",
    "text to speech",
    "tts",
    "translation",
  ],
  updated: "2026-11-05",
  body: [
    {
      type: "paragraph",
      text: "One Browser Source merges all four chats. Setup per platform, in **Chat & alerts**:",
    },
    {
      type: "list",
      items: [
        "**Twitch** — channel name only (anonymous read-only connection, no OAuth).",
        "**Kick** — channel name plus a one-time chatroom-id detection; if Kick's bot protection blocks it, the guided manual flow walks you through a copy-paste.",
        "**YouTube** — channel handle or URL; the chats from your public live broadcasts, including separate landscape and vertical streams, are combined automatically. Use a live-video URL to follow only that broadcast.",
        "**TikTok** — @username only, **no stream key needed**. Offline, the widget idles and reconnects when you go live.",
      ],
    },
    {
      type: "paragraph",
      text: "From the same page you control the full appearance studio (live preview), alert sounds (50+ bundled real recordings and synth effects, plus your own via link / upload / typed voice line — note that famous copyrighted clips can trigger VOD muting), text-to-speech chat readout, and free on-device translation.",
    },
    { type: "settingsLink", label: "Open Settings → Chat & alerts", href: "/settings?tab=chat" },
    { type: "heading", text: "Send replies from the Dock", anchor: "send-replies" },
    { type: "paragraph", text: "Open the Stream Dock's **Chat** section and type below the feed. **All available** selects every platform ready to send; the platform checkboxes let you choose one or several destinations. Choose **Connect chat sending** under Connected accounts to authorize Twitch, Kick or YouTube. A connected Twitch bot for the same channel can send as its bot account. The Dock reports sent, queued or failed separately for each destination. TikTok remains receive-only here; use TikTok LIVE to reply." },
    { type: "heading", text: "Disconnect a connected account", anchor: "disconnect" },
    { type: "paragraph", text: "In **Settings → Chat & alerts → Connected accounts**, choose **Disconnect** beside Twitch, Kick or YouTube. Check the platform named in the confirmation: disconnecting stops its notifications, chat sending and authorized stream controls. Choose **Disconnect Twitch**, **Disconnect Kick** or **Disconnect YouTube** to approve that account, or **Cancel** to keep it connected. Escape and closing the confirmation also cancel. No account is disconnected just by opening this confirmation." },
    { type: "paragraph", text: "Changing your signed-in account or replacing a connection cancels an earlier confirmation. If the result cannot be confirmed, check the account's current status before trying again. A new attempt asks for your approval again. Connecting notification alerts and granting stream-control permission remain separate choices." },
  ],
  related: ["obs-overlay-setup", "viewer-engagement", "troubleshooting-and-support"],
};

export default article;
