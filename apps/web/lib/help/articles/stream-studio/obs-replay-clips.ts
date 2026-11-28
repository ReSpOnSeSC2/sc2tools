import type { HelpArticle } from "@/lib/help/types";

const article: HelpArticle = {
  slug: "obs-replay-clips", title: "Save a clip after each game with OBS",
  summary: "For Kick, YouTube and offline recording: SC2 Tools saves OBS's replay buffer when a game ends, names the file from the game, and lists it in the Stream Dock's Clips panel.",
  category: "stream-studio", audience: "streamer", signedInOnly: true, order: 14, updated: "2026-11-28",
  keywords: ["clip", "clips", "replay buffer", "obs", "highlights", "kick", "youtube", "offline", "save replay", "game end"],
  body: [
    { type: "paragraph", text: "Kick has no clip button an app can press, so SC2 Tools asks OBS instead. When a game ends and its result is known, the desktop app tells OBS to save its replay buffer. The buffer holds only the last seconds you set in OBS, so the clip is the ending of the game, not a moment from the middle." },
    { type: "heading", text: "Turn it on", anchor: "turn-on" },
    { type: "steps", items: [
      "In OBS, open **Settings > Output > Replay Buffer**, turn it on and set how many seconds to keep. Then choose **Start Replay Buffer** in the Controls dock. OBS's WebSocket server must be on, as for the other stream features.",
      "In the desktop app's Streams page, turn on **Save an OBS replay-buffer clip** under **After each game**, then press **Save automatic title settings**. It starts off, and it needs your SC2 Tools account paired.",
      "The app tells you at once whether the buffer is running. SC2 Tools never starts the buffer for you; if it is stopped, the switch shows a hint and no clip is saved.",
    ] },
    { type: "heading", text: "Where the clip goes", anchor: "files" },
    { type: "list", items: [
      "The file moves into a **Highlights** folder next to the one OBS saved it in, named from the game, for example `2026-11-28 21-05 PvZ Victory vs Barcode on Alcyone LE.mkv`. Your OBS folders are not otherwise touched, and nothing is deleted or overwritten.",
      "The name uses the result, the matchup, the opponent and the map once the game's replay syncs. If it never syncs, the clip is filed ten minutes later with just the date and time.",
      "Only a video file OBS has just reported is moved. If it cannot be moved, it stays where OBS wrote it and the Streams page says so.",
    ] },
    { type: "heading", text: "In the Stream Dock", anchor: "dock" },
    { type: "paragraph", text: "Each filed clip is added to the [Stream Dock](/help/stream-dock) Clips panel as a **Clip** entry with the file name, beside your chat and game moments, so the list shows what to upload or post. The video itself stays on your PC." },
  ],
  related: ["stream-dock", "game-chapters", "desktop-stream-titles", "stream-guardian"],
};
export default article;
