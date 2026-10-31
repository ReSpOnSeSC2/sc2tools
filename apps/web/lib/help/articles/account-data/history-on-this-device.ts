import type { HelpArticle } from "@/lib/help/types";

const article: HelpArticle = {
  slug: "history-on-this-device",
  title: "Your history on this device",
  summary:
    "Daily Pulse can keep a copy of your game history in this browser. What is kept, how it updates, when it isn't kept and how to clear it.",
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
    "daily pulse",
    "season recap",
    "arcade",
    "keep on this device",
  ],
  updated: "2026-10-31",
  order: 30,
  body: [
    { type: "paragraph", text: "Daily Pulse can keep a copy of your game history in this browser. Next time, Daily Pulse, Season Recap and Arcade show that copy first, then check your account for games that are new or changed. Sometimes the whole history is downloaded again, for example after Delete history or a restore." },
    { type: "heading", text: "What is kept", anchor: "what-is-kept" },
    { type: "paragraph", text: "One row per game, for accounts with up to 20,000 games: the date, result, map and length; your race, MMR, build, macro score and Battle.net character ID; and the opponent's name, race, MMR, strategy, Battle.net character ID and SC2Pulse IDs. Replay files, build orders and charts stay in your account and are never copied here." },
    { type: "heading", text: "Keeping it up to date", anchor: "updates" },
    { type: "paragraph", text: "The line under the Daily Pulse cards shows when your history last updated and how many games are on screen. New games arrive by themselves after each upload while the page is open. **Refresh** checks now. If an update fails, **Try again** appears and the games already here stay on screen." },
    { type: "heading", text: "When it isn't kept", anchor: "not-kept" },
    {
      type: "list",
      items: [
        "You have more than 20,000 games. Only your latest 20,000 load, on each visit, and none are kept.",
        "Your browser blocks site data, or a private window doesn't allow it.",
        "It was cleared here (Clear, Delete history or a restore), or you opened Daily Pulse before it could keep history. Choose **Keep on this device** under the cards.",
        "Your browser removed site data to free space. Choose **Keep on this device** under the cards to keep it again.",
        "This browser couldn't store it, for example when it's short of space. The line under the cards says so; the next visit tries again, or choose **Keep on this device** when it appears.",
      ],
    },
    { type: "heading", text: "See or clear it", anchor: "clear" },
    { type: "settingsLink", label: "Open Backups & data", href: "/settings?tab=backups#device-history" },
    {
      type: "steps",
      items: [
        "Open Settings → Backups & data and find **Games on this device**.",
        "It shows how many games are stored and about how much space they take. The size is an estimate.",
        "Choose **Clear** to remove them from this device. Nothing is deleted from your account; Daily Pulse loads your history each visit until you choose **Keep on this device** again.",
      ],
    },
    { type: "heading", text: "Shared computers", anchor: "shared-computers" },
    { type: "paragraph", text: "Signing out, or signing in with another account, clears the history kept here when the next SC2 Tools page loads. Deleting your game history or restoring a snapshot clears it in the browser where you do it; other browsers replace theirs the next time they load your history, or clear it when they sign out. Deleting your account clears it in each browser once that browser sees you're signed out. Opponent names and IDs are part of the stored rows, so clear it before lending this computer to someone." },
  ],
  related: ["today", "arcade", "backups-and-export", "deleting-game-history"],
};

export default article;
