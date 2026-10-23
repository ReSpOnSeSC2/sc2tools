import type { HelpArticle } from "@/lib/help/types";

const article: HelpArticle = {
  slug: "backups-and-export",
  title: "Backups, snapshots and export",
  summary:
    "What's backed up and by whom: daily database backups, the snapshots you take and restore yourself, and the JSON export you keep.",
  category: "account-data",
  audience: "all",
  signedInOnly: true,
  keywords: [
    "backup",
    "back up",
    "restore",
    "snapshot",
    "restore point",
    "undo",
    "lost games",
    "export",
    "download my data",
    "json",
    "gdpr",
    "delete account",
    "atlas",
    "recovery",
  ],
  updated: "2026-10-23",
  body: [
    { type: "heading", text: "Deleting game history" },
    { type: "paragraph", text: "Take a snapshot first. In Settings → Backups & data, From and Through use your local time and include both chosen days. The confirmation dialog shows how many games will be deleted; an empty range cannot be confirmed. Re-sync from the desktop app afterwards to upload your replays again. [Step-by-step deletion guide](/help/deleting-game-history)." },
    {
      type: "paragraph",
      text: "Your data is protected in three ways. Each one does a different job, so it helps to know which one to reach for.",
    },
    {
      type: "table",
      head: ["Kind", "Who makes it", "What it covers", "Who can restore it"],
      rows: [
        [
          "**Daily database backup**",
          "Automatic, every day",
          "The whole SC2 Tools database, for everyone",
          "Only us, to recover the site after a failure",
        ],
        [
          "**Your snapshots**",
          "You, in Settings → Backups & data",
          "Your account: games list, opponents, notes, custom builds and settings",
          "You, any time, from the same page",
        ],
        [
          "**Your export**",
          "You, as a download",
          "The same account data as one JSON file you keep",
          "It's your copy to keep; it isn't loaded back in",
        ],
      ],
    },
    { type: "heading", text: "Daily database backups" },
    {
      type: "paragraph",
      text: "The SC2 Tools database runs on MongoDB Atlas, which takes an automatic, encrypted snapshot of the whole database every day and deletes old ones when their retention period ends. These backups are there so the site can be recovered after a server failure or data loss. They hold everyone's data at once, so they can't be used to bring back one account or undo one person's change. For that, take your own snapshot.",
    },
    {
      type: "paragraph",
      text: "Original replay files and replay-detail data (build orders, charts and the replay map view) are stored separately in Cloudflare R2 and aren't part of these backups. The desktop app can upload them again from the replays still on your PC.",
    },
    { type: "heading", text: "Take a snapshot" },
    {
      type: "steps",
      items: [
        "Open [Settings → Backups & data](/settings?tab=backups).",
        "Under **Snapshots**, press **Take a snapshot**. It appears in the list with when it was taken and its size.",
        "Take one before anything you might want to undo: a big import, a history wipe, or a round of edits to your custom builds.",
      ],
    },
    {
      type: "paragraph",
      text: "A snapshot holds your games list, opponents, opponent notes, custom builds, settings, overlay tokens and paired devices. It doesn't hold build orders, charts, the replay map view or original replay files. Coaching and community posts aren't in it either, so a restore never changes what other people see. Snapshots stay until you delete your account.",
    },
    { type: "heading", text: "Restore a snapshot" },
    {
      type: "steps",
      items: [
        "In [Settings → Backups & data](/settings?tab=backups), find the snapshot and press **Restore**.",
        "Read the confirmation and press **Restore**. Your games list, opponents, notes, custom builds and settings go back to how they were when the snapshot was taken. Games added since then are removed.",
        "Open the desktop app and click **Re-sync**. It uploads your replays again, which brings back build orders, charts, replay files and any newer games that are still on your PC.",
      ],
    },
    {
      type: "callout",
      tone: "warning",
      title: "A restore replaces, it doesn't merge",
      text: "Everything in your account that the snapshot covers is replaced. If you're unsure, take a fresh snapshot first: then you can always go back to right now.",
    },
    { type: "heading", text: "Export your data" },
    {
      type: "paragraph",
      text: "**Export my data** in [Settings → Backups & data](/settings?tab=backups) downloads everything stored for your account as one JSON file: your account details, games list, opponents, notes, custom builds, settings, overlay tokens and the rest of your account records. Build orders and charts aren't in the file. Original replays download one at a time with the download button on each game.",
    },
    { type: "heading", text: "When you delete something" },
    {
      type: "list",
      items: [
        "**Delete game history** and **Delete my account** remove the data from the live database and from replay storage straight away. Deleting your account also deletes your snapshots.",
        "Copies already inside the daily database backups aren't edited. They're deleted on their own when those backups reach the end of their retention period.",
        "There's no undo for deleting your account. Export your data first if you want to keep a copy. See the [privacy policy](/legal/privacy) for the details.",
      ],
    },
  ],
  related: ["getting-started", "troubleshooting-and-support"],
  order: 20,
};

export default article;
