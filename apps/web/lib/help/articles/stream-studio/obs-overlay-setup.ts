import type { HelpArticle } from "@/lib/help/types";

const article: HelpArticle = {
  slug: "obs-overlay-setup",
  title: "OBS overlay setup",
  summary:
    "Choose a starter pack, drag correctly sized widgets into OBS, and test your setup while keeping private URLs hidden.",
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
  updated: "2026-10-25",
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
        "Open **Settings → Overlay → Widgets**, or choose **Enable this setup** from a starter setup in the Stream Studio crash course. Sign in when prompted; the link returns to the same pack. Review the list of widgets that will be enabled and those already on. **Cancel** changes nothing. **Enable setup** keeps your other enabled widgets. If another tab changed the selection, refresh it and review again.",
        "Search the grouped widget cards or choose **Enabled only**. Each card shows an illustrative thumbnail, its recommended width and height, Enable, Copy, Test and How it works. **Drag into OBS** supplies the name and size automatically; or add an OBS **Browser Source**, use **Copy** and enter the recommended dimensions. Copy also works with Streamlabs, which may ignore OBS drag parameters. Backgrounds are transparent. Test the result and allow extra space for long content or a larger theme.",
        "Press **Test** on a widget to show sample content for about 20 seconds. During a detected live match, Settings asks before sending: **Send anyway** puts samples on your on-air sources; **Preview here instead** opens a local sample page in a new tab and sends nothing to OBS. **Stop** or automatic expiry restores your real opponent and session, which keep updating beneath the sample.",
        "URLs are hidden by default. **Copy** always copies the complete private URL; if clipboard access fails, a selected text field lets you copy it yourself. **Reveal** shows that row for this visit, and **Hide URL** masks it again. These bearer URLs grant access to your overlay, so treat them like passwords.",
        "Use **Setup** for the All-in-one URL, connection checks and the private Stream Dock URL. In OBS, add the Dock under **Docks → Custom Browser Docks**. **Look** holds theme, Ghost matchup assignments and Build profile; **Chat & alerts**, **Scenes**, **Dock & bot** and **Tokens** keep the other controls together. Theme and Ghost changes are still encoded in copied URLs, so copy them again after making those changes. Widget enable changes reach connected OBS sources automatically.",
      ],
    },
    { type: "paragraph", text: "The Practice pack enables Randomizer and Scouting. Ghost Build coach remains URL-enabled: choose and assign a saved timed build in **Look**, then copy its widget URL. Packs do not add Browser Sources or connect streaming accounts for you. Your unfinished chat and bot edits stay available when moving between Overlay sections in this tab." },
    { type: "heading", text: "Preview locally before testing on stream", anchor: "playground" },
    { type: "paragraph", text: "Choose **Preview** on a Settings widget card, use the interactive examples in the widget guides, or open the public playground. Select a widget or **Show all together**, choose a theme preset and try Pre-game, Victory, Defeat, Cheese, Hot streak, Chat burst or Poll. The silent stage uses illustrative sample data without an account or overlay token. **Actual size** scrolls inside the stage; **Replay sample** restarts timed content. These choices change only the local preview. Then use **Test** to verify your actual OBS source, size and saved setup. **Preview here instead** during a live match opens this playground and sends no sample to OBS." },
    { type: "settingsLink", label: "Open the local widget playground", href: "/stream-studio/playground" },
    { type: "settingsLink", label: "Open Settings → Overlay → Widgets", href: "/settings?tab=overlay&section=widgets" },
    { type: "heading", text: "Check a source and recover its connection", anchor: "connection-check" },
    { type: "paragraph", text: "Overlays reconnect automatically after an outage. Refresh a Browser Source after a site update if it is still running old code; a brief connection failure should recover on its own. Add **?check=1** to an overlay URL (or **&check=1** when it already has a query) to show its connection status inside OBS for 10 seconds." },
    { type: "paragraph", text: "**This overlay link no longer works** means the token was revoked or mistyped. Copy a fresh URL from **Settings → Overlay**. The notice shrinks after a minute. The Stream Dock shows the same terminal state and stops retrying a revoked token. While your saved Dock controls are loading, editors stay locked; failed saves keep what you typed so you can edit and Retry." },
  ],
  related: ["multi-platform-chat", "stream-dock", "obs-auto-scene-switching", "voice", "troubleshooting-and-support"],
};

export default article;
