import type { HelpArticle } from "@/lib/help/types";

const article: HelpArticle = {
  slug: "stream-dock",
  title: "Stream Dock (your control panel)",
  summary:
    "A second-screen control panel for your stream: chat highlights, polls and build votes, goals, BRB scenes, the recap card and the clip-moment log.",
  category: "stream-studio",
  audience: "streamer",
  signedInOnly: true,
  order: 3,
  keywords: [
    "dock",
    "control panel",
    "custom browser dock",
    "second screen",
    "phone",
    "poll",
    "build vote",
    "stream goals",
    "brb",
    "starting soon",
    "clip",
    "block spammers",
  ],
  updated: "2026-10-22",
  body: [
    {
      type: "paragraph",
      text: "The Stream Dock URL (shown in the multichat settings) is a second-screen control panel — add it in OBS via **Docks → Custom Browser Docks**, or open it on a phone. From it you can: pin a chat highlight on stream (and have it read aloud), run chat polls and **build votes** (chat picks your opening from your real saved builds), update stream goals, switch **BRB / Starting Soon scenes** with a countdown, fire the session recap card, review the **clip-moment log** (every chat spike and big game moment, timestamped with the chat lines that caused it), and block spammers everywhere at once.",
    },
  ],
  related: ["multi-platform-chat", "viewer-engagement"],
};

export default article;
