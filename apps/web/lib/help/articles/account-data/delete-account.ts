import type { HelpArticle } from "@/lib/help/types";

const article: HelpArticle = {
  slug: "delete-account",
  title: "Deleting your account",
  summary:
    "What deleting your SC2 Tools account removes, what to save first, how to do it, and the gentler option of deleting only your game history.",
  category: "account-data",
  audience: "all",
  signedInOnly: true,
  order: 30,
  keywords: [
    "delete account",
    "close account",
    "remove account",
    "delete my data",
    "erase",
    "gdpr",
    "right to be forgotten",
    "privacy",
    "export",
    "delete game history",
    "start over",
  ],
  updated: "2026-10-23",
  body: [
    {
      type: "paragraph",
      text: "Delete your SC2 Tools account from [Settings → Backups & data](/settings?tab=backups). This permanently removes live account data and ends your sign-in identity. Comments on other people's review requests are anonymized instead of removed.",
    },
    { type: "heading", text: "Before you delete", anchor: "before" },
    {
      type: "list",
      items: [
        "Press **Export my data** on the same page to download a copy of your games list, opponents, notes, custom builds and settings as one file.",
        "Download any original replays you want to keep from [Replays](/app/replays). Your replays also stay in your StarCraft II folder on your PC.",
        "On your gaming PC, quit the desktop app or uninstall it, so it stops trying to sync.",
      ],
    },
    { type: "heading", text: "Delete your account", anchor: "how" },
    {
      type: "steps",
      items: [
        "Open [Settings → Backups & data](/settings?tab=backups).",
        "Under **Export & delete account (GDPR)**, press **Delete my account**.",
        "Step 1 offers **Download my data**. Keep the JSON export if you need it, or Continue without an export.",
        "Step 2 shows live counts of what is removed and anonymized, plus the current database backup retention window. If the inventory cannot load, press Retry inventory.",
        "Step 3 asks you to type `DELETE` exactly, then press **Delete account permanently**. You are signed out and taken to the account-deleted page.",
      ],
    },
    { type: "heading", text: "What's removed", anchor: "what-is-removed" },
    {
      type: "list",
      items: [
        "Your games, analysis, opponents, notes, custom builds, settings, overlay links, paired devices, private snapshots, sounds, Stream Studio/viewer/prediction records and connected Twitch, Kick and YouTube credentials.",
        "Your original replay files and map playback recordings.",
        "Builds you published to Community, the channels you linked to your player identity, and your public profile and replay page, whose links stop working.",
        "Your coaching relationships, review requests and their threads, notifications and private support message text. Comments you wrote on other people's review requests remain as [deleted user]. Activity records lose account identifiers.",
        "Copies already inside service database backups are not edited individually. They expire under the configured schedule shown in the dialog, account-deleted page and [privacy policy](/legal/privacy). If the current window cannot be read, the page says so; contact support for the schedule.",
      ],
    },
    {
      type: "paragraph",
      text: "If the sign-in provider is temporarily unavailable, identity deletion is retried automatically. The deleted identity cannot reopen the account while that retry is pending. After completion, a keyed guard remains for 30 days to reject old sessions and late identity events; it contains no plain user ID or email. A paired PC that receives an unauthorized response shows **This PC was unlinked** and stops automatic sync. Pair again only after deliberately creating a new account.",
    },
    { type: "heading", text: "Only want a fresh start?", anchor: "delete-history-instead" },
    {
      type: "paragraph",
      text: "**Delete game history**, on the same page, removes your games and opponent records but keeps your account, custom builds, overlay links and paired devices. You can limit it to a date range. Afterwards, press **Re-sync** in the desktop app to upload your replays again. Take a snapshot first if you might want to go back.",
    },
  ],
  related: ["backups-and-export", "public-profile", "troubleshooting-and-support"],
};

export default article;
