import type { HelpArticle } from "@/lib/help/types";

const article: HelpArticle = {
  slug: "custom-chat-commands",
  title: "Custom chat commands",
  summary: "Add plain-text replies, choose platforms and cooldowns, preview saved commands, and copy a Nightbot snippet.",
  category: "stream-studio",
  audience: "streamer",
  signedInOnly: true,
  order: 5,
  keywords: ["chat commands", "custom", "alias", "Nightbot", "variables", "cooldown", "Twitch", "Kick", "YouTube", "TikTok"],
  updated: "2026-10-25",
  body: [
    { type: "steps", items: [
      "Open **Settings → Overlay → Multi-platform chat** and choose your overlay token. Find **Chat command settings** below the command guide.",
      "Use **Add custom command**. Give it a name such as `hello`, without spaces. Names start with a letter and use at most 24 letters, numbers or underscores. Built-in names, default aliases and engagement commands are reserved.",
      "Write a one-line reply of up to 1,000 characters. Use plain text and the supported variables below. You can save up to 25 custom commands.",
      "Choose **Enabled**, a cooldown from 5 to 3,600 seconds, the platforms where it answers, and whether it can appear in on-stream answers. An empty platform selection disables replies everywhere.",
      "Select **Save chat commands**. Edits remain local until Save. Set the preview argument, viewer, platform and on-stream context, then select **Try it** on a saved command. Preview shows the exact reply without sending a message or consuming a cooldown.",
    ] },
    { type: "heading", text: "Variable reference", anchor: "variables" },
    { type: "table", head: ["Variable", "Value"], rows: [
      ["`{user}`", "The viewer name supplied by chat or the preview."],
      ["`{mmr}`", "Your latest recorded MMR; unavailable data is labelled in the reply."],
      ["`{record}`", "Today's recorded wins and losses by matchup (UTC)."],
      ["`{opponent}`", "Your current or last recorded opponent."],
      ["`{streak}`", "Your recorded win or loss streak."],
    ] },
    { type: "paragraph", text: "For example, `Hi {user}! Today: {record}.` Only the five variables above are supported. Markup and unknown variables are rejected. Outgoing replies are clipped to 380 characters, so preview longer responses before using them." },
    { type: "heading", text: "Built-ins, aliases and cooldowns", anchor: "availability" },
    { type: "paragraph", text: "Built-in commands use the same settings. A configured alias adds another name; canonical names and default aliases remain available. Disabling a built-in disables every name for it. Saved platform and on-stream settings apply across the bot, Nightbot and the on-stream command endpoint. Viewer rank, predictions and voting retain their separate engagement behavior." },
    { type: "paragraph", text: "A command shares its configured cooldown across its names. Each viewer also has a five-second reply limit. Chat replies and on-stream answers use separate cooldown lanes so one chat message can produce both. Missing replay or session data is described honestly rather than guessed." },
    { type: "heading", text: "Use a command in Nightbot", anchor: "nightbot" },
    { type: "steps", items: [
      "Save the command and allow the **nightbot** platform.",
      "Select **Copy Nightbot** for that command. If clipboard access is unavailable, select and copy the read-only fallback field.",
      "In your own Nightbot configuration, create the matching trigger and paste the snippet into its response field. Nightbot's `urlfetch` reads the plain-text reply; `querystring` encodes the viewer and command arguments. See [Nightbot URL Fetch](https://docs.nightbot.tv/variables/urlfetch) and [QueryString](https://docs.nightbot.tv/variables/querystring).",
    ] },
    { type: "callout", tone: "warning", title: "Keep your snippet private", text: "The snippet contains your overlay token. Keep it in your Nightbot command configuration. Copying a snippet or saving command settings does not connect an account, enable a bot or send a message." },
    { type: "settingsLink", label: "Open Overlay settings", href: "/settings?tab=overlay" },
  ],
  related: ["viewer-engagement", "multi-platform-chat", "stream-dock"],
};
export default article;
