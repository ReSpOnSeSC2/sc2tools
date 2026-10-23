import type { HelpArticle } from "@/lib/help/types";

const article: HelpArticle = {
  slug: "obs-overlay-setup",
  title: "OBS overlay setup",
  summary:
    "Put Stream Studio widgets on stream: copy a widget URL into an OBS Browser Source, test it with sample content, and save changes without touching OBS again.",
  category: "stream-studio",
  audience: "streamer",
  signedInOnly: true,
  order: 1,
  keywords: [
    "obs",
    "overlay",
    "browser source",
    "widget",
    "widget url",
    "overlay token",
    "streamlabs",
    "test button",
    "transparent",
    "stream",
  ],
  updated: "2026-10-23",
  body: [
    {
      type: "settingsLink",
      label: "Stream Studio crash course & widget guides",
      href: "/stream-studio/learn",
    },
    {
      type: "paragraph",
      text: "Learn what each widget does, choose a starting setup, and follow the steps to put it in OBS.",
    },
    {
      type: "steps",
      items: [
        "Open **Settings → Overlay**. Your overlay token is created for you the first time you open it, and every widget URL is listed with a **Copy** button. The token in the URL is the key to your overlay, so treat these URLs like passwords.",
        "Each widget has its own URL — add one OBS **Browser Source** per widget you want and position it freely. Backgrounds are transparent.",
        "Press **Test** on any widget to render clearly-labelled sample content for ~20 seconds — place and style everything without waiting for a real game.",
        "Widgets show up when something happens (a game starts or ends) and auto-hide between games; persistent HUDs like the session record stay up. Config changes reach OBS within about a minute of pressing Save — no Browser Source edits needed.",
      ],
    },
    { type: "settingsLink", label: "Open Settings → Overlay", href: "/settings?tab=overlay" },
    { type: "heading", text: "Check a source and recover its connection", anchor: "connection-check" },
    { type: "paragraph", text: "Overlays reconnect automatically after an outage. Refresh a Browser Source after a site update if it is still running old code; a brief connection failure should recover on its own. Add **?check=1** to an overlay URL (or **&check=1** when it already has a query) to show its connection status inside OBS for 10 seconds." },
    { type: "paragraph", text: "**This overlay link no longer works** means the token was revoked or mistyped. Copy a fresh URL from **Settings → Overlay**. The notice shrinks after a minute. The Stream Dock shows the same terminal state and stops retrying a revoked token. While your saved Dock controls are loading, editors stay locked; failed saves keep what you typed so you can edit and Retry." },
  ],
  related: ["multi-platform-chat", "stream-dock", "obs-auto-scene-switching", "voice", "troubleshooting-and-support"],
};

export default article;
