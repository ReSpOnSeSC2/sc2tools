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
  updated: "2026-10-22",
  body: [
    {
      type: "paragraph",
      text: "One Browser Source merges all four chats. Setup per platform, in **Overlay → Multi-platform chat**:",
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
    { type: "settingsLink", label: "Open Settings → Overlay", href: "/settings?tab=overlay" },
  ],
  related: ["obs-overlay-setup", "viewer-engagement", "troubleshooting-and-support"],
};

export default article;
