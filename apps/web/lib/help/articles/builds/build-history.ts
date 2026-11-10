import type { HelpArticle } from "@/lib/help/types";

const article: HelpArticle = {
  slug: "build-history",
  title: "Undo changes and restore deleted builds",
  summary:
    "Every save keeps the version it replaces, so you can restore an earlier one from History. Deleted builds wait in Recently deleted for 30 days.",
  category: "builds",
  audience: "player",
  signedInOnly: true,
  keywords: [
    "undo", "undo delete", "restore", "version history", "history", "previous version",
    "recently deleted", "trash", "deleted build", "recover build",
  ],
  updated: "2026-11-10",
  body: [
    {
      type: "paragraph",
      text: "Your custom builds are safe to change. Each save keeps the version it replaced, and a deleted build stays restorable for 30 days.",
    },
    { type: "heading", text: "Undo a delete", anchor: "undo-delete" },
    { type: "list", items: [
      "After you delete a build, a message says **Deleted “name”** with **Undo** for 10 seconds. Undo on a build's own page takes you back to it.",
      "A build that was published loses its Community listing when you delete it. **Undo** brings it back private: you'll see **Restored privately. Publish again to relist it.**",
    ] },
    { type: "heading", text: "Recently deleted", anchor: "recently-deleted" },
    { type: "paragraph", text: "**Recently deleted (n)** in your [build library](/builds) lists builds deleted in the last 30 days with the date each one is removed for good. **Restore** puts a build back in your library, private, and re-matches your replays so its games return to it. After 30 days a nightly cleanup removes the build and its history permanently." },
    { type: "heading", text: "Version history", anchor: "history" },
    { type: "steps", items: [
      "Open a build's page and choose **History**.",
      "Each entry is a version you replaced, newest first (the last 20 are kept). **Compare** shows what differs from the current build, rule by rule.",
      "**Restore this version** saves it as the current build and re-matches your replays. The version you replaced joins History, so a restore can be undone the same way.",
    ] },
    { type: "callout", tone: "info", text: "Pins, tags and the Community listing are not part of a version. Restoring keeps the build's current ones." },
  ],
  related: ["custom-builds", "build-library", "build-import-export"],
  order: 22,
};

export default article;
