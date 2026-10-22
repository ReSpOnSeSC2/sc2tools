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
  updated: "2026-10-22",
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
        "In **Settings → Overlay**, create (or copy) an overlay token — the token IS the key, so treat the URLs like passwords.",
        "Each widget has its own URL — add one OBS **Browser Source** per widget you want and position it freely. Backgrounds are transparent.",
        "Press **Test** on any widget to render clearly-labelled sample content for ~20 seconds — place and style everything without waiting for a real game.",
        "Widgets show up when something happens (a game starts or ends) and auto-hide between games; persistent HUDs like the session record stay up. Config changes reach OBS within about a minute of pressing Save — no Browser Source edits needed.",
      ],
    },
    { type: "settingsLink", label: "Open Settings → Overlay", href: "/settings?tab=overlay" },
  ],
  related: ["multi-platform-chat", "stream-dock", "troubleshooting-and-support"],
};

export default article;
