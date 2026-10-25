import type { HelpArticle } from "@/lib/help/types";

const article: HelpArticle = {
  slug: "stream-dock",
  title: "Stream Dock (your control panel)",
  summary:
    "Your game and session at a glance, with Crystal Ball controls, stream-safe hiding, approved opponent shout-outs, chat, polls and scenes.",
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
      text: "Open **Game**, the first section, for your current opponent, race, available MMR and head-to-head record, matchup, game phase and session W–L, MMR change and streak. The sticky header keeps the scene and countdown, active opponent, session record, connection label and counts of connected overlay sources visible as you scroll. Opponent details clear after the match or a connection reset. Current desktop agents do not supply a live map name; **Map unavailable live** is an honest source limitation.",
    },
    {
      type: "callout",
      tone: "info",
      title: "Crystal Ball fair play",
      text: "The Game card shows votes and the voting-lock countdown. **Cancel round** closes the selected round with no points. **Resolve Win/Loss** requires confirmation and is available for 30 minutes after that matching game ends without a replay-verified result, until a new match starts. Its reveal says **resolved manually**, awards no oracle points, and is excluded from oracle accuracy. Verified results remain the scoring source.",
    },
    {
      type: "paragraph",
      text: "Choose **Start new session**, then confirm, to count games from now and set the clip log's stream-start mark to now. The reset boundary belongs to your account, so your connected session widgets update together. **Hide game widgets** saves a reversible pause for this Dock's overlay token: game cards, scouting voice, session, Crystal Ball and stats ticker hide. Chat, polls, scenes, timers and manual Build profile controls keep running. Choose **Show game widgets** to resume. Refresh existing Browser Sources once after updating so they honor hiding and manual-result labels.",
    },
    {
      type: "paragraph",
      text: "**Shout out** is enabled only when the active opponent has an approved Twitch or YouTube channel linked to their exact Pulse identity or Battle.net toon. A connected matching Twitch bot queues the message; otherwise **Copy shout-out** provides text and a manual-copy fallback. The bot's **!so** command answers only for that approved current opponent and does not accept another target. Uncertain identities or missing approved links leave the action unavailable.",
    },
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
