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
  updated: "2026-10-25",
  body: [
    {
      type: "paragraph",
      text: "SC2 Tools reads your StarCraft II replays and turns them into stats, scouting notes and stream widgets. Setup takes about five minutes. The pill at the top of the app shows whether your desktop app is online and when your latest game was played.",
    },
    {
      type: "steps",
      items: [
        "**Welcome: choose your goals.** [Sign up](/sign-up). Signing up from [/try](/try) saves the games you analyzed there. Otherwise, use [Setup](/welcome) to choose **Improve my play**, **Upgrade my stream**, or both. Setup takes about five minutes; importing a large replay library can run longer in the background.",
        "**Install the desktop app.** Download it from the [Download](/download) page and install it on the PC you play on (Windows 10 or 11). It watches your replay folder; you never upload anything by hand. Step by step: [Install and link the desktop app](/help/install-and-pair).",
        "**Pair it with your account.** The app shows a 6-digit code. Open its pairing page, or enter the code on [Devices](/devices), then confirm the PC. Setup checks for its connection. Already paired? The Pair circle has a check mark and Continue skips that step. See [Pairing problems](/help/pairing-troubleshooting) for expired codes and connection help.",
        "**Play or import a game.** Every ladder game is read automatically a few seconds after it ends and synced to your account. To fill your stats right away, press **Import my history** in the setup checklist on your dashboard to add the replays already on your PC.",
        "**Done: you're set.** Keep an eye on import progress, then open your latest game, check your SC2 identity, or follow the [Stream Studio crash course](/stream-studio/learn#crash-course). Your chosen goals determine the suggested next actions; every feature stays available.",
      ],
    },
    {
      type: "paragraph",
      text: "Signed up from a guide or build? You'll be taken back to it. The setup banner names your return page, and both Skip for now and the final Continue button return there. Otherwise, they open your dashboard. Refreshing keeps the setup step in the page URL. Completed numbered circles let you revisit earlier steps. If you choose browser import on Download, Back from Import returns to Download. [Setup](/welcome) and the dashboard checklist help you continue later. Setup resumes at Import when a PC is paired, or Done when games have arrived, unless you explicitly revisit a step.",
    },
    {
      type: "paragraph",
      text: "Choose Save, a vote or Practice on a public build while signed out to finish that action after sign-in. That browser tab remembers the choice for 15 minutes and only the original page can use it. A saved Practice choice opens Ghost settings with a confirmation; your existing Ghost source URL stays the same. If the choice expires or a request fails, use the action button again. Switching accounts or leaving a page stops its pending confirmation.",
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
