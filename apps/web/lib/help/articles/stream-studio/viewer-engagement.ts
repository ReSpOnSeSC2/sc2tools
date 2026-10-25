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
    {
      type: "paragraph",
      text: "Viewers on all four platforms share one progression: 2 XP per chat message plus bonuses for subs, raids, gifts and Super Chats. Levels climb a StarCraft unit ladder themed by the race you pick in the multichat settings; the supporter wall shows today's top 5 and announces level-ups on stream. Before each of your games, chat calls `!win` or `!loss` — the verified result awards oracle points and shows whether chat was right. Everything below is what your viewers can type:",
    },
    { type: "widget", widget: "chat-commands" },
    {
      type: "paragraph",
      text: "The stats commands above come from the same registry as the chat bot, on-stream answers and Nightbot endpoint. In **Settings → Overlay → Multi-platform chat → Chat command settings**, change a command's alias, enabled state, cooldown, platforms and on-stream answers. Canonical names and default aliases stay available; disabling a built-in disables all of its names. Use **Try it** after saving to see the exact reply without sending a message.",
    },
    {
      type: "callout",
      tone: "info",
      title: "Tip",
      text: "The same card in **Overlay → Multi-platform chat** copies the bio text with your saved commands and rank race. When you separately enable the **Chat bot**, it posts answers in Twitch chat and counts `!win`/`!loss` calls and XP with the dock closed. Platform connection and bot activation are separate from saving command settings.",
    },
  ],
  related: ["multi-platform-chat", "stream-dock", "custom-chat-commands"],
};

export default article;
