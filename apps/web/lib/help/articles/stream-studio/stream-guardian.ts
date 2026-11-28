import type { HelpArticle } from "@/lib/help/types";

const article: HelpArticle = {
  slug: "stream-guardian", title: "Stream Guardian: warnings while you stream",
  summary: "Four optional warnings, all off until you turn them on: a muted microphone, dropped frames, a game with OBS not live, and a break scene left on. They reach you as a quiet tray notice and a banner in the Stream Dock, never on your stream.",
  category: "stream-studio", audience: "streamer", signedInOnly: true, order: 14, updated: "2026-11-27",
  keywords: ["stream guardian", "muted microphone", "mic muted", "dropped frames", "reconnecting", "not recording", "brb", "break scene", "warning", "obs", "dock", "tray notice"],
  body: [
    { type: "paragraph", text: "Stream Guardian watches OBS from the desktop app and tells you, off-stream, about the mistakes that ruin a stream. A warning is a tray notice on your PC and a red banner at the top of the [Stream Dock](/help/stream-dock). It is never drawn on your stream and never plays a sound, so your viewers and your capture cannot hear or see it." },
    { type: "heading", text: "The four warnings", anchor: "rules" },
    { type: "table", head: ["Warning", "When it appears", "When it clears"], rows: [
      ["Microphone muted", "The OBS input you chose as your microphone has been muted for two minutes while you are live.", "You unmute it, or you stop streaming."],
      ["Frames dropping or reconnecting", "OBS is reconnecting to your platform, or has skipped 5 percent or more of its frames in two checks in a row.", "Two clean checks in a row."],
      ["Game with OBS not live", "A game has been running for a few seconds and OBS is neither streaming nor recording. A plugin output such as Aitum counts as running.", "OBS starts streaming or recording, or the game ends."],
      ["Live on a break scene", "You are live on a scene whose name has BRB, break, starting soon, intermission, AFK or away in it, twenty minutes after your last game ended or after you switched to it.", "You leave the scene, or stop streaming."],
    ] },
    { type: "paragraph", text: "Each warning appears once per incident. If you fix the cause and it happens again, you get a new warning." },
    { type: "heading", text: "Turn it on", anchor: "setup" },
    { type: "steps", items: [
      "In OBS, turn on the WebSocket server (Tools, WebSocket Server Settings). The desktop app already uses it for scene switching.",
      "Open **Streams** in the desktop app and find **Stream Guardian**.",
      "Tick the warnings you want. Every one starts off.",
      "For the muted-microphone warning, press **Find OBS inputs** and pick the input you speak into. You can also type its name exactly as OBS shows it.",
      "Press **Save Stream Guardian settings**.",
    ] },
    { type: "heading", text: "What it reads and when", anchor: "checks" },
    { type: "list", items: [
      "While every switch is off, SC2 Tools makes no request to OBS for this feature.",
      "While OBS is not live and a rule that needs a live stream is on, it makes a couple of quick status reads every fifteen seconds, only to notice that you went live; those rules do not run until you are. The game rule alone reads OBS only while a game runs.",
      "While you are live, or a game is running, it checks every five seconds.",
      "It only reads from OBS. It changes nothing in your scenes or settings.",
      "If OBS is closed or its WebSocket is off, nothing is known and nothing warns. A single failed read does not end a warning that is showing.",
    ] },
    { type: "heading", text: "The Dock banner", anchor: "dock" },
    { type: "paragraph", text: "The banner needs the desktop app paired with your SC2 Tools account. It disappears when the cause clears, and also within about three minutes if the desktop app closes. The tray notice works without an account. If your notifications are muted in the desktop app, only the banner shows." },
  ],
  related: ["stream-dock", "game-chapters", "desktop-stream-titles"],
};
export default article;
