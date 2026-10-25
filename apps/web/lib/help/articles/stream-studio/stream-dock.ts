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
  updated: "2026-10-25",
  body: [
    {
      type: "paragraph",
      text: "Tap a section title to collapse it; pin the sections you use every game to the top.",
    },
    {
      type: "paragraph",
      text: "The Stream Dock URL (shown in the multichat settings) is a second-screen control panel — add it in OBS via **Docks → Custom Browser Docks**, or open it on a phone. From it you can: pin a chat highlight on stream (and have it read aloud), run chat polls and **build votes** (chat picks your opening from your real saved builds), update stream goals, switch **Starting Soon, BRB, Intermission and Stream ending scenes** with a countdown, fire the session recap card, review the **clip-moment log** (every chat spike and big game moment, timestamped with the chat lines that caused it), and block spammers everywhere at once.",
    },
    {
      type: "paragraph",
      text: "In Scenes, choose **Starting Soon**, **BRB**, **Intermission** or **Stream ending**. Set an optional message and countdown first; your last five submitted messages are saved per Dock as reusable, removable chips. **Go live** clears the scene. Returning live from Starting Soon marks the stream start only when no mark exists; ending the stream does not change that mark. Refresh existing scene Browser Sources once after this update so they recognize the new modes.",
    },
    {
      type: "paragraph",
      text: "Choose **Custom poll** for your own question or **Build vote** to select two or three saved builds. Matchup chips filter the build list. The running poll locks its mode until you clear it. Close the build vote to see the winner and **Open build** in a new tab. An empty list links to Builds; failed loads offer Retry.",
    },
    {
      type: "paragraph",
      text: "Block a chat author with the two-tap Block action. For six seconds, **Undo** removes that Dock block. Open **Blocked users** below Chat to search and **Unblock** someone later; the Dock holds up to 50 users. Users marked **Managed in Settings → Overlay** are read-only here and must be removed in Settings. Names match without regard to letter case. Blocked users' messages and votes are excluded from both the Dock and the on-stream poll.",
    },
  ],
  related: ["multi-platform-chat", "viewer-engagement"],
};

export default article;
