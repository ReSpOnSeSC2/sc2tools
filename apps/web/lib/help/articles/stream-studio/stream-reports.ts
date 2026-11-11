import type { HelpArticle } from "@/lib/help/types";

const article: HelpArticle = {
  slug: "stream-reports", title: "Stream reports",
  summary: "A recap of each stream: record, MMR, maps, builds, best win, randomizer games, Crystal Ball accuracy and clip moments, saved when you end the stream in the Dock.",
  category: "stream-studio", audience: "streamer", signedInOnly: true, order: 12, updated: "2026-11-10",
  keywords: ["stream report", "stream recap", "end stream", "post-stream", "crystal ball accuracy", "copy discord summary", "dock"],
  body: [
    { type: "heading", text: "Start and end a stream", anchor: "start-and-end" },
    { type: "steps", items: [
      "When you go live, press **Start new session** in the [Stream Dock](/help/stream-dock).",
      "Play as usual. Every game you upload counts toward this stream.",
      "When you finish, press **End stream**. If you forget, the stream closes on its own after four hours without a game.",
    ] },
    { type: "paragraph", text: "The report then appears in your notifications and under [Stream reports](/app/streams). A stream with no games saves no report. Only your newest 100 stream reports are kept." },
    { type: "heading", text: "What it shows", anchor: "what-it-shows" },
    { type: "list", items: [
      "**Games, record and time in games**, plus your record by matchup, map and build.",
      "**MMR** at the start and end of the stream, its peak, and a small line of every rated game in between.",
      "**Best win:** your win against the highest-rated opponent, by matchup, map and opponent MMR. Opponent names are not stored.",
      "**Randomizer builds:** how many games you played on a rolled build, and your record on them.",
      "**Crystal Ball:** how many rounds and calls chat made, and the share of calls that were right once there are at least five.",
      "**Top supporters and oracles:** the five highest event counts and best Crystal Ball records, without viewer names.",
      "**Clip moments:** paste this stream’s Twitch or YouTube recording link to open the marked times in the video.",
    ] },
    { type: "heading", text: "Share it", anchor: "share" },
    { type: "paragraph", text: "**Copy Discord summary** copies a short text recap with your record, MMR, matchups, best win and builds. It never includes opponent or viewer names. To post automatically instead, see [Post your games to Discord](/help/discord)." },
    { type: "paragraph", text: "If your public player page is enabled, **Share report** creates a public link with your record, time played, matchup records and MMR change. The link omits opponent and viewer information. **Turn off sharing** ends access. Turning off the public player page or stream reports also revokes the link." },
    { type: "heading", text: "Turn it off", anchor: "settings" },
    { type: "paragraph", text: "Switch off **Stream reports** in [Settings → Preferences → Reports](/settings?tab=preferences#reports). **End stream** still closes the session, but no report is saved." },
  ],
  related: ["stream-dock", "weekly-report", "discord", "viewer-engagement"],
};
export default article;
