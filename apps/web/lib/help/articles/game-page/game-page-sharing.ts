import type { HelpArticle } from "@/lib/help/types";

const article: HelpArticle = {
  slug: "game-page-sharing",
  title: "Sharing a game",
  summary: "Send one game to a friend or post it: a share link with the map replay that needs no account, a battle card image, or your public replay page. Turn a link off at any time.",
  category: "game-page",
  audience: "player",
  signedInOnly: true,
  order: 2,
  updated: "2026-11-10",
  keywords: ["share link", "share a game", "public link", "revoke", "turn off link", "manage share links", "battle card", "no account", "reddit", "discord"],
  body: [
    { type: "paragraph", text: "Open the game, then choose **Share** in its header. The same menu is on each game in [Replays](/app/replays). There are three ways to share, and each shows different things." },
    { type: "heading", text: "A share link", anchor: "share-link" },
    { type: "paragraph", text: "**Copy share link** creates a private, hard-to-guess address for this one game the first time you use it, then copies it. Anyone who has the link can open the game's analysis and map replay without an account. Nothing else of yours is reachable from it." },
    { type: "list", items: [
      "Viewers see the result, matchup, map, length, the date (without a time), both builds as the replay classifier named them, your macro score, the battle report, the timeline, mechanics, both build orders and the map replay.",
      "The opponent is never named: they appear by race, and both ratings are rounded to the nearest 100. You appear by race too.",
      "Your notes, build check-ins and corrections, review requests and the rest of your history are never included.",
      "Player names are recorded inside original .SC2Replay files. A share link never offers the file.",
      "Links show a preview card when posted in chats and forums. Search engines are asked not to list them.",
    ] },
    { type: "paragraph", text: "The Share menu on the game page also copies links only you can open, one at the replay's current moment, and your public replay page's link; see [the game page](/help/game-page#sharing). To share the battle report, see [Share a report](/help/battle-reports#share)." },
    { type: "heading", text: "Turn a link off", anchor: "turn-off" },
    { type: "paragraph", text: "Choose **Manage share links…** in the Share menu to copy the link, see how many times it was opened, or **Turn off link**. Turning it off blocks new playback requests and the link shows a not-available page. A short-lived direct segment URL already issued can work for up to 60 seconds. Copying a link again afterwards creates a new address. Deleting the game or your account turns its links off too. You can have up to 200 live links." },
    { type: "heading", text: "A battle card image", anchor: "image" },
    { type: "paragraph", text: "**Save battle card image** makes a picture of the result for posts and chats. It shows your MMR and whether your opponent was higher or lower, rounded to the nearest 100, never their name or exact rating. An image cannot be turned off once it is posted." },
    { type: "heading", text: "Your public replay page", anchor: "public-replays" },
    { type: "paragraph", text: "Public replays share your whole replay archive on your player page. The archive and analysis keep opponent names private. Visitors can open a replay preview without an account and sign in for analysis. Original replay downloads contain the names and chat recorded by StarCraft II. It is a separate setting from share links; see [Public profile](/help/public-profile). A share link works whether or not that page is on." },
  ],
  related: ["game-page", "battle-reports", "public-profile"],
};

export default article;
