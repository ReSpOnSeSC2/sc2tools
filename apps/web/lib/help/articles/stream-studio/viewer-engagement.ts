import type { HelpArticle } from "@/lib/help/types";

const article: HelpArticle = {
  slug: "viewer-engagement",
  title: "Viewer engagement: XP, ranks & predictions",
  summary:
    "How viewers earn XP and ranks across every platform, call your games with !win and !loss, and every chat command they can type.",
  category: "stream-studio",
  audience: "streamer",
  signedInOnly: true,
  order: 4,
  keywords: [
    "chat commands",
    "commands",
    "xp",
    "loyalty",
    "rank",
    "level",
    "predictions",
    "oracle points",
    "supporter wall",
    "chat bot",
    "bio",
  ],
  updated: "2026-10-25",
  body: [
    { type: "heading", text: "Twitch Predictions and game markers", anchor: "twitch-predictions" },
    { type: "paragraph", text: "Twitch Channel Points Predictions are optional and separate from Crystal Ball oracle points. In Settings → Chat & alerts → Twitch automation, both switches default off. The server owner must enable the feature separately; saving preferences cannot activate a paused server. Automation requires an affiliate or partner broadcaster and a live channel." },
    { type: "callout", tone: "warning", title: "Current desktop limitation", text: "Current desktop telemetry cannot prove whether a live game is ranked, so automatic Twitch Predictions are skipped. MMR, Pulse profiles and old replays never substitute for queue evidence. Fresh live two-human 1v1 starts can still add opted-in stream markers; markers require VODs enabled." },
    { type: "steps", items: ["Use Connect Predictions for its separate Channel Points permission, or Connect markers for stream-control permission. Complete Twitch's window, then Refresh status. Connecting changes neither switch.", "Choose a whole prediction window from 30 to 300 seconds (default 120). Titles support {me}, {opp}, {oppRace} and {oppMmr}; Win/Loss are fixed. Twitch titles are shortened to 45 characters and missing MMR shows ?.", "Enable the choices you want, then Save Twitch automation. Markers use a description such as vs Opp · PvZ · Map; the map remains unavailable when live telemetry has none.", "Stream Dock → Game shows native Twitch state. Resolve uses only a stored replay-verified result, never a manually chosen outcome. Confirm Cancel / refund to request a Channel Points refund." ] },
    { type: "paragraph", text: "Predictions skip rematches within 10 minutes. Games under 60 seconds and no verified result within 20 minutes request refunds. A reconnect can recover the same broadcaster's known prediction IDs. Unconfirmed creates are never blindly repeated or matched to an arbitrary Twitch prediction. If its ID was not returned, the Dock explains that automatic cancellation is unavailable: check the Twitch dashboard manually. A refund appears as confirmed only after Twitch confirms cancellation. A resolution already in progress cannot be overridden by a late Cancel." },
    { type: "settingsLink", label: "Open Twitch automation settings", href: "/settings?tab=chat#twitch-automation" },
    { type: "heading", text: "Crystal Ball and viewer commands" },
    {
      type: "paragraph",
      text: "Viewers on all four platforms share one progression: 2 XP per chat message plus bonuses for subs, raids, gifts and Super Chats. Levels climb a StarCraft unit ladder themed by the race you pick in the multichat settings; the supporter wall shows today's top 5 and announces level-ups on stream. Before each of your games, chat calls `!win` or `!loss` — the verified result awards oracle points and shows whether chat was right. Everything below is what your viewers can type:",
    },
    { type: "widget", widget: "chat-commands" },
    {
      type: "paragraph",
      text: "The stats commands above come from the same registry as the chat bot, on-stream answers and Nightbot endpoint. In **Settings → Chat & alerts → Chat command settings**, change a command's alias, enabled state, cooldown, platforms and on-stream answers. Canonical names and default aliases stay available; disabling a built-in disables all of its names. Use **Try it** after saving to see the exact reply without sending a message.",
    },
    {
      type: "callout",
      tone: "info",
      title: "Crystal Ball fair play",
      text: "Only replay-verified results award oracle points or affect accuracy. In Stream Dock → Game, Cancel round awards nothing. For 30 minutes after a matching game ends without a verified result, before another match starts, the streamer can confirm Resolve Win or Resolve Loss; viewers see **resolved manually**, with no points or accuracy change. Voting locks early in the game, and a late verified replay cannot score a cancelled or manually resolved round.",
    },
    {
      type: "paragraph",
      text: "**!so** asks the enabled Twitch bot for the current opponent's approved stream links. It ignores arbitrary targets and stays silent when the opponent has no approved exact identity match. Stream Dock → Game also offers Shout out, with Copy shout-out when a matching bot is unavailable.",
    },
    {
      type: "callout",
      tone: "info",
      title: "Tip",
      text: "The same card in **Chat & alerts** copies the bio text with your saved commands and rank race. When you separately enable the **Chat bot**, it posts answers in Twitch chat and counts `!win`/`!loss` calls and XP with the dock closed. Platform connection and bot activation are separate from saving command settings.",
    },
  ],
  related: ["multi-platform-chat", "stream-dock", "custom-chat-commands"],
};

export default article;
