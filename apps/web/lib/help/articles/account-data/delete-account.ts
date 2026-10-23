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
      text: "You can delete your SC2 Tools account and everything stored for it at any time, from [Settings → Backups & data](/settings?tab=backups). It can't be undone.",
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
        "Type `DELETE` to confirm and press **Delete account**. You're taken back to the home page.",
      ],
    },
    { type: "heading", text: "What's removed", anchor: "what-is-removed" },
    {
      type: "list",
      items: [
        "Your games, opponents, notes, custom builds, settings, overlay links, paired devices and snapshots, and your connected Twitch, Kick and YouTube accounts.",
        "Your original replay files and map playback recordings.",
        "Builds you published to Community, the channels you linked to your player identity, and your public profile and replay page, whose links stop working.",
        "Copies inside our daily database backups aren't edited; they're deleted on their own when those backups expire. See [Backups, snapshots and export](/help/backups-and-export) and the [privacy policy](/legal/privacy).",
      ],
    },
    {
      type: "paragraph",
      text: "Signing in again later with the same login starts a new, empty account.",
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
