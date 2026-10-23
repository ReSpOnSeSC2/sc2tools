import type { HelpArticle } from "@/lib/help/types";

const article: HelpArticle = {
  slug: "desktop-scouting",
  title: "Private scouting at the loading screen",
  summary: "See your record, recent opening history and private opponent note in the desktop card, then leave a note for your next meeting.",
  category: "desktop-app",
  audience: "all",
  signedInOnly: true,
  keywords: ["scouting", "loading screen", "opponent", "private note", "dossier", "head to head", "usually", "best answer", "first meeting"],
  updated: "2026-10-23",
  body: [
    { type: "paragraph", text: "The paired desktop app can show a small private scouting strip when a human 1v1 loads. It uses your account's existing opponent history. The strip stays visible after you lock in a build, then disappears with the loading card about 30 seconds into the game. It uses the desktop card's non-activating window, so there is no keyboard shortcut you need to press while loading." },
    { type: "heading", text: "Show or hide scouting", anchor: "turn-on" },
    { type: "steps", items: [
      "Open the desktop app's **Settings → Build check-in**. Keep **Enable build check-ins** on and turn **Show scouting at loading** on. This scouting choice applies immediately and is saved on this PC.",
      "With **Ask during the loading screen** on, scouting appears inside the normal build-picking card. With that switch off, it uses a slim **Private scouting** card with no build choices. **Close** dismisses only this game's scouting card.",
      "Turn **Show scouting at loading** off to keep your build cards without scouting. Turning the master Enable build check-ins switch off stops automatic cards altogether. The website's three check-in switches do not change this PC's scouting choice.",
    ] },
    { type: "heading", text: "Read the strip", anchor: "record" },
    { type: "list", items: [
      "**You 3–2 · last met 2 days ago (L on Alcyone)** is your record and most recent meeting. **First meeting** requires a confirmed empty history; **No confirmed record yet** means an exact record was unavailable.",
      "**Usually: 12 Pool (3 of last 5)** names the most common recorded opening and its actual sample count. **Best: Hatch First 3–1** shows the build with the best qualifying record in your opponent history. Small samples describe past games; they are not a promise about this game.",
      "Your private opponent note takes up at most two lines. **Open dossier** opens the opponent in your browser, where you can read the full history and note. If the opponent's exact account is not known, it opens your Opponents list instead and does not show a private note from a name-only match.",
    ] },
    { type: "heading", text: "Leave a note for next time", anchor: "notes" },
    { type: "steps", items: [
      "After the game, open **Note for next time** on the desktop check-in card. The replay must have synced and identified the opponent before saving is available.",
      "Write up to **500 characters** and press **Save note**. **Saved for next time** confirms it reached your opponent dossier. A failed save keeps your draft and offers another attempt.",
      "This replaces your private note for that opponent. It is separate from the game notes used with Confirm or Done: use **Save note** before closing the card if you want to keep the opponent note. It is not enabled for read-aloud.",
    ] },
    { type: "heading", text: "Privacy and missing cards", anchor: "privacy" },
    { type: "paragraph", text: "Private notes are sent to your authenticated desktop devices, separately from OBS overlay events. The desktop requests Windows capture exclusion for its card. Check your own capture setup before putting a private note on screen; capture tools and capture modes can behave differently." },
    { type: "list", items: [
      "No strip yet? Keep the desktop app linked and connected, and allow the current game's history to arrive. A missing brief does not open an empty scouting-only card.",
      "Loading cards need Windowed or Windowed (Fullscreen) StarCraft II, a human 1v1 and a known matchup. Random matchups wait for the after-game check-in.",
      "Missing record or note? An ambiguous player name is not enough to show another account's history. Let the replay sync, then use the dossier for the identified opponent.",
    ] },
  ],
  related: ["build-check-in", "opponents", "desktop-app-overview"],
};

export default article;
