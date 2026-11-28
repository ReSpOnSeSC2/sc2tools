import type { HelpArticle } from "@/lib/help/types";

const article: HelpArticle = {
  slug: "game-chapters", title: "Game chapters for your stream video",
  summary: "One chapter per game in your YouTube archive's description when you end the stream, text to paste into Twitch and Kick descriptions, and an optional marker in your local OBS recording.",
  category: "stream-studio", audience: "streamer", signedInOnly: true, order: 13, updated: "2026-11-27",
  keywords: ["chapters", "youtube chapters", "timestamps", "vod", "description", "obs recording", "chapter marker", "end stream", "dock"],
  body: [
    { type: "heading", text: "What a chapter looks like", anchor: "format" },
    { type: "paragraph", text: "Each game becomes one line: the time it started in the video, the game number, the matchup, the result and your opponent's rating rounded to 100, for example `0:42:10 Game 4 · PvZ win vs 5.1k`. Opponent names are never used." },
    { type: "heading", text: "In your YouTube archive", anchor: "youtube" },
    { type: "steps", items: [
      "Turn on **Write chapters to YouTube at End stream** in the Dock's Clips panel. It starts off, and it needs YouTube connected through SC2 Tools with the broadcast made by SC2 Tools.",
      "Press **Start new session** when you go live and **End stream** when you finish, in the [Stream Dock](/help/stream-dock).",
      "The Dock tells you whether the chapters were written, or why not.",
    ] },
    { type: "list", items: [
      "The chapters sit between two marker lines in the description. A second run replaces that block and never touches the rest of your text.",
      "Times count from when YouTube says the broadcast went live, so a late **Start new session** does not shift them.",
      "YouTube only shows chapters when the list starts at 0:00, has at least three entries and keeps them ten seconds apart. When that is not possible nothing is written and the Dock says why.",
      "A description is limited to 5,000 bytes. If the block does not fit, nothing is written.",
    ] },
    { type: "heading", text: "For Twitch and Kick", anchor: "copy" },
    { type: "paragraph", text: "In the Dock's Clips panel press **Show chapters**, then **Copy chapters**. The times count from the stream start you marked, the same as the clip moments. Paste the lines into a video description or a Kick or Twitch panel." },
    { type: "heading", text: "In your OBS recording", anchor: "obs" },
    { type: "paragraph", text: "In the desktop app's Streams page, turn on **Add a chapter to the OBS recording** under **At each game start**. Each game then adds a chapter such as `Game 4 · PvZ` to the file OBS is recording. It needs OBS 30.2 or newer recording to Hybrid MP4; with an older OBS, another format or no recording it quietly does nothing. A player that shows chapters, such as VLC, lists them." },
  ],
  related: ["stream-dock", "stream-reports", "desktop-stream-titles"],
};
export default article;
