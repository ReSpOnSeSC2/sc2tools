import type { HelpArticle } from "@/lib/help/types";
const article: HelpArticle = {
  slug: "deleting-game-history", title: "Deleting game history", summary: "Preview and delete all your games or an inclusive local date range while keeping your account and builds.", category: "account-data", audience: "player", signedInOnly: true, keywords: ["delete", "wipe", "history", "date range", "backup", "resync"], updated: "2026-10-23", related: [],
  body: [
    { type: "settingsLink", label: "Open Backups & data", href: "/settings?tab=backups" },
    { type: "steps", items: ["Take a **snapshot** before deleting game history, so you have a restore point.", "In **Delete game history**, optionally choose **From** and **Through (inclusive)**. Dates use your local time and both chosen days are included. Leave both dates empty for all games.", "Open the delete dialog and check how many games will be deleted. A range with no games cannot be confirmed. If counting fails, the dialog says so before you decide.", "Type **DELETE** and confirm. Opponent records and macro data for those games are removed too. Your custom builds, paired devices, overlay tokens and account stay.", "Re-sync from the desktop app afterwards if you want to upload your replays again."] },
  ],
};
export default article;
