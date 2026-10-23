import type { HelpArticle } from "@/lib/help/types";

const article: HelpArticle = {
  slug: "getting-started",
  title: "Getting started (5 minutes)",
  summary:
    "Create your account, install and pair the desktop app, get your first games in, and find your way around Today, Settings and Stream Studio.",
  category: "getting-started",
  audience: "all",
  order: 1,
  keywords: [
    "setup",
    "set up",
    "install",
    "sign up",
    "account",
    "download",
    "agent",
    "pair",
    "pairing code",
    "6-digit code",
    "code expired",
    "devices",
    "first game",
    "import history",
    "today",
    "dashboard",
    "new user",
  ],
  updated: "2026-10-23",
  body: [
    {
      type: "paragraph",
      text: "SC2 Tools reads your StarCraft II replays and turns them into stats, scouting notes and stream widgets. Setup takes about five minutes.",
    },
    {
      type: "steps",
      items: [
        "**Create your account.** [Sign up](/sign-up) on the website. A short setup guide opens right after and walks you through the next steps.",
        "**Install the desktop app.** Download it from the [Download](/download) page and install it on the PC you play on (Windows 10 or 11). It watches your replay folder; you never upload anything by hand. Step by step: [Install and link the desktop app](/help/install-and-pair).",
        "**Pair it with your account.** The app opens showing a 6-digit pairing code. Click **Open pairing page**, or go to [Devices](/devices) yourself, and enter the code. The code expires after 10 minutes; if it does, close the app and open it again to get a new one.",
        "**Play or import a game.** Every ladder game is read automatically a few seconds after it ends and synced to your account. To fill your stats right away, press **Import my history** in the setup checklist on your dashboard to add the replays already on your PC.",
        "**Read Today.** [Today](/app) is your between-games view: the live game while you play, your session record, streak and MMR, and the Daily Pulse strip with fresh insights from your own games every day. Builds, maps, trends and opponent history fill in as replays land.",
        "**Find Settings and Stream Studio.** [Settings](/settings) holds your profile, overlay, build check-in and voice options, plus this help. Streaming? [Stream Studio](/stream-studio) is the overlay suite: in **Settings → Overlay**, copy a widget URL into an OBS Browser Source and press its **Test** button to see it live.",
      ],
    },
    {
      type: "callout",
      tone: "info",
      title: "Where the numbers come from",
      text: "Win rates, build matches, MMR and every other stat are computed from your replays with fixed rules, never AI. The same replays always give the same numbers.",
    },
    {
      type: "paragraph",
      text: "Your [build library](/builds) needs a free account; [Community builds](/community) and [Definitions](/definitions) are public. See [Which pages are public?](/help/a-page-asked-me-to-sign-in) for the full list.",
    },
    {
      type: "paragraph",
      text: "Stuck on a step? Search Help for the words on your screen, or see [Troubleshooting & support](/help/troubleshooting-and-support).",
    },
  ],
  related: ["how-to-use-help", "install-and-pair", "settings-overview", "dashboard-and-analyzer", "obs-overlay-setup", "a-page-asked-me-to-sign-in"],
};

export default article;
