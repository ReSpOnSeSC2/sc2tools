import type { HelpArticle } from "@/lib/help/types";

const article: HelpArticle = {
  slug: "discord", title: "Post your games to Discord",
  summary: "Send ranked results, session summaries, your weekly recap, MMR peaks and league promotions to a channel in your own Discord server through a webhook. Off until you turn it on.",
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
      "**Each ranked result:** win or loss, matchup, map, your build, recorded starting MMR and game length. Unranked and custom games are never posted.",
      "**Session summaries:** your record, time played, MMR change and matchups once a session ends (after your session gap passes with no new game).",
      "**Weekly recap:** the headline numbers from your [weekly report](/help/weekly-report).",
      "**MMR peaks and promotions:** a rated game can set a new best after at least 20 rated games on the account and race. A promotion appears when two successive ranked 1v1 replays on the same account and ladder race show a higher league. Replays without league data can still report results.",
    ] },
    { type: "paragraph", text: "Tick or untick each kind per channel. Posts are queued and sent within about a minute; if Discord is busy they are retried for a while, then dropped." },
    { type: "heading", text: "Privacy", anchor: "privacy" },
    { type: "list", items: [
      "**Opponent names are off by default.** Posts show the opponent's race and MMR only, unless you turn on **Show opponent names**.",
      "**Show MMR** is on by default; turn it off to post results without ratings.",
      "**Include replay links** is off by default. Automatic posts link to your replay archive only if you share it publicly. When both ranked results and replay links are enabled, you can also post a single-game [battle report](/help/battle-reports#share) from its share dialog.",
    ] },
    { type: "heading", text: "When a channel stops", anchor: "stopped" },
    { type: "paragraph", text: "If Discord rejects a webhook three times in a row (usually because it was deleted or its channel removed), SC2 Tools switches that channel off and sends you a notification. Create a new webhook and connect it again. Nothing is posted while your account is being deleted, and deleting your account removes every connected channel." },
  ],
  related: ["weekly-report", "stream-reports", "notifications", "public-profile"],
};
export default article;
