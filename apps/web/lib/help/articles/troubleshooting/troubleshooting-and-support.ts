import type { HelpArticle } from "@/lib/help/types";

const article: HelpArticle = {
  slug: "troubleshooting-and-support",
  title: "Troubleshooting & support",
  summary:
    "Quick fixes when overlay changes don't show in OBS, sound is missing, Kick won't connect or a widget is blank, and how to reach us.",
  category: "troubleshooting",
  audience: "streamer",
  keywords: [
    "not working",
    "stale",
    "refresh",
    "cache",
    "no sound",
    "audio",
    "voice",
    "kick",
    "blank widget",
    "bug",
    "support",
    "contact",
    "email",
    "status",
    "website",
    "api",
  ],
  updated: "2026-10-25",
  body: [
    {
      type: "list",
      items: [
        "**Website or data not loading?** Open [System status](/status), also available from the website footer or **More → System status**. It works without signing in. Website and API checks run from your browser when you open the page; select **Refresh checks** to try again. **Reachable** means the public endpoint answered, **Unavailable** means it returned an HTTP error, and **Unknown** means the browser could not verify it. Check the timestamp: these checks do not measure replay processing, every feature or historical uptime.",
        '**Changes not showing in OBS?** Press Save first — widgets re-read their config within ~60 seconds. If it still looks stale, right-click the Browser Source → Interact/Refresh, or "Refresh cache of current page".',
        "**No sound or voice?** Browsers can block audio until a click — open the source with Interact and click once, then TTS/sounds run normally.",
        "**Kick won't auto-detect?** Use the guided manual flow in the Kick row — open the shown URL in your own browser and paste what you see; the id is extracted for you.",
        "**Widget blank?** Check the widget is enabled for your token in Settings → Overlay, and use its Test button to confirm placement.",
        "**The source says its link no longer works?** The token was revoked or rotated, or the URL was mistyped. Copy a fresh URL from **Settings → Overlay**, then replace the Browser Source or Dock URL. Overlays reconnect themselves after a temporary outage. Add **?check=1** (or **&check=1** after an existing query) for a 10-second connection badge in OBS.",
        "**Still stuck?** Inside the app, open **Help & support** (the life-buoy icon in the desktop top bar; **More → Help & support** on a phone), then **Report a problem**. On a help page, use **Report a problem** at the end of the article. See [Report a problem or suggest a feature](/help/report-a-problem) for what goes with it.",
      ],
    },
  ],
  related: ["report-a-problem", "something-went-wrong", "obs-overlay-setup", "multi-platform-chat", "getting-started"],
};

export default article;
