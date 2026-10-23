import type { HelpArticle } from "@/lib/help/types";

const article: HelpArticle = {
  slug: "backups-and-export",
  title: "Backups, snapshots and export",
  summary:
    "Create, label and download restore points, then preview a restore that keeps existing build orders and replay files for shared games.",
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
    "recovery",
  ],
  updated: "2026-10-23",
  body: [
    { type: "heading", text: "Deleting game history" },
    { type: "paragraph", text: "A Before action snapshot is saved automatically before deletion. In Settings → Backups & data, From and Through use your local time and include both chosen days. The confirmation dialog shows how many games will be deleted; an empty range cannot be confirmed. Re-sync from the desktop app afterwards to upload your replays again. [Step-by-step deletion guide](/help/deleting-game-history)." },
    {
      type: "paragraph",
      text: "Snapshots work with large game histories and download as compressed files. Your JSON export is a separate copy to keep, and cannot be uploaded as a restore point.",
    },
    { type: "heading", text: "Types and retention", anchor: "retention" },
    { type: "table", head: ["Type", "When created", "Retention"], rows: [["Manual", "When you press Take a snapshot", "Newest 5"], ["Weekly", "Lazily on the first successful ingest of an ISO week, starting Monday in UTC", "Newest 2"], ["Before action", "Before a restore, history wipe or repair", "Newest 3"]] },
    { type: "paragraph", text: "Older snapshots of each type are pruned. Download a copy you need to keep longer. This page restores snapshots still in your account, not files uploaded from your computer." },
    { type: "heading", text: "Take a snapshot" },
    {
      type: "steps",
      items: [
        "Open [Settings → Backups & data](/settings?tab=backups).",
        "Under **Snapshots**, press **Take a snapshot**. The row shows its type, age, compressed size and saved counts.",
        "Add a useful label and press **Save label**. **Download** keeps a gzip NDJSON copy; **Delete snapshot** removes only that backup, leaving your current games unchanged.",
      ],
    },
    {
      type: "paragraph",
      text: "A snapshot holds your games list, opponents, notes, custom builds, profile, ordinary settings and overlay tokens. Heavy game details and replay binaries are separate. Paired PCs, onboarding goals/checklist progress, notification choices, import history, coaching and community records stay outside restore. Old work queues are never revived.",
    },
    { type: "heading", text: "Restore a snapshot" },
    {
      type: "steps",
      items: [
        "In [Settings → Backups & data](/settings?tab=backups), find the snapshot and press **Restore**.",
        "Wait for the verified preview. Check games kept, removed and added, plus custom builds, notes and tokens. If preview fails, **Try again**; Restore stays disabled. Confirm **Restore** only after checking these numbers. A fresh Before action snapshot is saved first.",
        "Build orders, charts, replay-map data and original replay files for game IDs in both your current list and the snapshot are kept. Games absent from the snapshot and their files are removed. Restored games absent from your current data may need a desktop **Re-sync** to recover their files.",
      ],
    },
    {
      type: "callout",
      tone: "warning",
      title: "A restore replaces, it doesn't merge",
      text: "Check the preview before confirming. Covered data is replaced. A snapshot contains no heavy game details or replay binaries, so files already deleted need a desktop Re-sync from replays on your PC. Keep a download of any snapshot you need beyond its retention limit.",
    },
    { type: "paragraph", text: "If backup storage is unavailable or an archive cannot be verified, restore does not change your current data. Existing uploaded replays are checked before restore. For derived-data problems, try [Fixing wrong opponent counts](/help/repair-my-data)." },
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
  related: ["deleting-game-history", "repair-my-data", "delete-account"],
  order: 20,
};

export default article;
