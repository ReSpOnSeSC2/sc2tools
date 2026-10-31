import type { HelpArticle } from "@/lib/help/types";

const article: HelpArticle = {
  slug: "history-on-this-device",
  title: "Your history on this device",
  summary:
    "Daily Pulse can keep your game history in this browser, so it opens at once and only downloads new games. What is kept, how it updates and how to clear it.",
  category: "account-data",
  audience: "player",
  signedInOnly: true,
  keywords: [
    "offline",
    "local storage",
    "local copy",
    "storage space",
    "cache",
    "clear",
    "faster",
    "daily pulse",
    "season recap",
    "arcade",
    "keep on this device",
  ],
  updated: "2026-10-31",
  order: 30,
  body: [
    { type: "paragraph", text: "Daily Pulse can keep your game history in this browser. After the first load, Daily Pulse, Season Recap and Arcade open at once and only download games that are new or changed since your last visit." },
    { type: "heading", text: "What is kept", anchor: "what-is-kept" },
    { type: "paragraph", text: "One row per game, for up to your latest 20,000 games: date, result, map, races, MMR, length, builds, the opponent's name and your macro score. Replay files, build orders and charts stay in your account and are never copied here." },
    { type: "heading", text: "Keeping it up to date", anchor: "updates" },
    { type: "paragraph", text: "The line under the Daily Pulse cards shows when your history last updated and how many games are on this device. New games arrive by themselves after each upload. **Refresh** checks now. If an update fails, **Try again** appears and the games already here stay on screen." },
    { type: "heading", text: "When it isn't kept", anchor: "not-kept" },
    {
      type: "list",
      items: [
        "You have more than 20,000 games. They load in full on each visit instead.",
        "Your browser blocks site data, or a private window doesn't allow it.",
        "You opened Daily Pulse before this existed, or cleared it. Choose **Keep on this device** under the cards.",
        "Your browser removed site data to free space. The next visit downloads your history again.",
      ],
    },
    { type: "heading", text: "See or clear it", anchor: "clear" },
    { type: "settingsLink", label: "Open Backups & data", href: "/settings?tab=backups#device-history" },
    {
      type: "steps",
      items: [
        "Open Settings → Backups & data and find **Games on this device**.",
        "It shows how many games are stored and about how much space they take. The size is an estimate.",
        "Choose **Clear** to remove them from this device. Nothing is deleted from your account; the next visit downloads them again.",
      ],
    },
    { type: "heading", text: "Shared computers", anchor: "shared-computers" },
    { type: "paragraph", text: "Signing out, or signing in with another account, clears the history kept here when the next SC2 Tools page loads. Deleting your game history, restoring a snapshot and deleting your account clear it too. Opponent names are part of the stored rows, so clear it before lending this computer to someone." },
  ],
  related: ["today", "arcade", "backups-and-export", "deleting-game-history"],
};

export default article;
