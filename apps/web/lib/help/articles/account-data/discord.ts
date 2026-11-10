import type { HelpArticle } from "@/lib/help/types";

const article: HelpArticle = {
  slug: "discord", title: "Post your games to Discord",
  summary: "Send ranked results, session summaries, your weekly recap and new MMR peaks to a channel in your own Discord server through a webhook. Off until you turn it on.",
  category: "account-data", audience: "all", signedInOnly: true, order: 27, updated: "2026-11-10",
  keywords: ["discord", "webhook", "post results", "clan", "team channel", "session summary", "weekly recap", "mmr peak"],
  body: [
    { type: "heading", text: "Create a webhook in Discord", anchor: "create-webhook" },
    { type: "steps", items: [
      "In Discord, open **Server Settings → Integrations → Webhooks**. You need the Manage Webhooks permission.",
      "Choose **New Webhook**, pick the channel, then press **Copy Webhook URL**.",
      "In SC2 Tools, open [Settings → Integrations](/settings?tab=integrations), paste the URL, give it a name only you see, and press **Connect channel**.",
      "Press **Preview posts** to see exactly what each kind of post will look like, then switch the channel on. **Send test** posts a short hello to check the connection.",
    ] },
    { type: "paragraph", text: "Only Discord webhook links are accepted. The link is stored encrypted and shown afterwards only as its last four characters. It is never included in your data export. You can connect up to three channels." },
    { type: "heading", text: "What is posted", anchor: "what-is-posted" },
    { type: "list", items: [
      "**Each ranked result:** win or loss, matchup, map, your build, MMR change and game length. Unranked and custom games are never posted.",
      "**Session summaries:** your record, time played, MMR change and matchups once a session ends (after your session gap passes with no new game).",
      "**Weekly recap:** the headline numbers from your [weekly report](/help/weekly-report).",
      "**New MMR peaks:** when a rated game takes an account and race above its previous best, once you have at least 20 rated games there.",
    ] },
    { type: "paragraph", text: "Tick or untick each kind per channel. Posts are queued and sent within about a minute; if Discord is busy they are retried for a while, then dropped." },
    { type: "heading", text: "Privacy", anchor: "privacy" },
    { type: "list", items: [
      "**Opponent names are off by default.** Posts show the opponent's race and MMR only, unless you turn on **Show opponent names**.",
      "**Show MMR** is on by default; turn it off to post results without ratings.",
      "**Link to the public replay** is off by default and only works when your replay archive is shared publicly.",
    ] },
    { type: "heading", text: "When a channel stops", anchor: "stopped" },
    { type: "paragraph", text: "If Discord rejects a webhook three times in a row (usually because it was deleted or its channel removed), SC2 Tools switches that channel off and sends you a notification. Create a new webhook and connect it again. Nothing is posted while your account is being deleted, and deleting your account removes every connected channel." },
  ],
  related: ["weekly-report", "stream-reports", "notifications", "public-profile"],
};
export default article;
