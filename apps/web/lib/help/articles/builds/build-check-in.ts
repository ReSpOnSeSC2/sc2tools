import type { HelpArticle } from "@/lib/help/types";

const article: HelpArticle = {
  slug: "build-check-in",
  title: "Build check-in: count the build you went for",
  summary:
    "Say which build you were going for, at the loading screen or after the game, so each build's record counts the games you planned it. You can also correct the opponent's build.",
  category: "builds",
  audience: "player",
  signedInOnly: true,
  keywords: [
    "check-in",
    "check in",
    "planned build",
    "what's the plan",
    "loading screen card",
    "after game card",
    "randomizer",
    "opponent's build",
    "correct opponent build",
    "add new build",
    "custom build",
    "build record",
    "win rate",
    "planned badge",
  ],
  updated: "2026-10-23",
  body: [
    {
      type: "paragraph",
      text: "A game normally counts toward a build only when the replay matches every step of it, so games where you were knocked off the plan (a scouted proxy, lost workers, an early all-in) never count against that build. With **Build check-in** you say which build you were going for, at the loading screen or after the game. A confirmed check-in counts the game toward that build's win/loss record even when the replay was classified as something else, so each build's record shows how the plan really does. You can also correct the **opponent's build** when the replay named it wrong, and save a build you don't have yet as a new custom build right from the check-in.",
    },
    { type: "heading", text: "What you need" },
    {
      type: "list",
      items: [
        "The **desktop app, version 0.19.0 or newer**, running and signed in. It shows the in-game cards. Without it you can still check in from the website.",
        "StarCraft II in **Windowed (Fullscreen)** or Windowed mode for the loading-screen card. It can't draw over exclusive Fullscreen; the after-game card and the website still work.",
        "1v1 games against a human. Team games, games vs the AI and games under 45 seconds are skipped.",
      ],
    },
    { type: "heading", text: "Turn it on" },
    {
      type: "steps",
      items: [
        "Open [Settings → Build check-in](/settings?tab=checkin). Three switches, all on by default: **Build check-ins** (the master switch), **Ask during the loading screen** and **Ask after each game**. Press Save.",
        "The desktop app's Settings tab has the same three switches, kept in sync with the website. Every card also has a quick link to stop asking (**Don't ask at loading**, **Turn off check-ins after games**).",
      ],
    },
    { type: "heading", text: "Preview and move the cards", anchor: "preview-and-move" },
    {
      type: "steps",
      items: [
        "In the desktop app, open **Settings → Build check-in → Cards**. Choose **Preview loading card** or **Preview after-game card**. They work even when check-ins are off. The **Preview - nothing is saved** chip marks fixed sample data, including a sample scouting strip; no game, build choice or private note is sent to the server.",
        "Drag the card by its header into place. Its position is remembered for real cards too. Any answer button closes a preview locally; Esc or 90 seconds also closes it. A real game card replaces the preview immediately.",
        "Press **Reset card positions** to return visible cards to their default spot and clear their remembered positions. **Positions reset** confirms the reset. **Open check-in queue on sc2tools.com** opens the website when you want to handle real games.",
      ],
    },
    { type: "heading", text: "Keyboard check-in", anchor: "keyboard" },
    {
      type: "paragraph",
      text: "Click into the after-game card's search and type a build name. **Enter** picks and focuses the top visible match (your featured builds first, then More builds). **Ctrl+Enter** confirms the selected build. With no matches, Enter leaves your choice unchanged. **Down** moves from search to the first row without picking it; **Up** on that row returns to search. **Esc** closes the opponent's build list first, then means Later. Cards never request focus from the game automatically; these keys apply after you choose to interact with a card.",
    },
    { type: "heading", text: "How a game goes" },
    {
      type: "steps",
      items: [
        "**Loading screen.** A small **What's the plan?** card appears on the right side of the screen with the matchup and your opponent. Click one of **Your builds**, sorted by how often you play them in this matchup and shown with your record, or open **More builds…** for every build in the matchup (your saved custom builds plus the standard build list). The card never takes keyboard focus from the game: click and keep playing. It then shows **Locked in** with a **Change** button and goes away about 30 seconds into the game. **Not now** means you'll decide after the game.",
        "**Build randomizer.** If the randomizer is on for the matchup, the card reads *Randomizer will roll — pick a build to skip it*. Pick a build and the randomizer doesn't roll on stream for that game; **Roll now** rolls it right away; do nothing and it rolls after a few seconds. The rolled build is marked **Rolled** and is treated as your plan: after the game it's pre-selected unless your replay clearly went a different way. You still confirm it.",
        "**After the game.** When the game ends, **Which build were you going for?** appears with a best guess already selected and a label saying why: you picked it at loading, it was the randomizer roll, it best matches your replay, it's your closest custom build, or it's your usual build for the matchup. *Replay classified as …* shows what the replay looked like. Press **Confirm**, pick a different build, choose **No set build** (you weren't going for anything in particular; the game keeps the replay's label) or **Later**. Use the notes box for what threw the build off. Ctrl+Enter confirms, Esc means Later. Once your replay has uploaded, the card also shows **Opponent's build** and **Add new build…** (see below).",
        "**Picked at loading?** If the replay matched your pick there's nothing to do. If it didn't, a short **What happened?** card asks for a note: **Done** keeps your pick, **Change build** switches it.",
        "**Missed one?** The **Build check-ins (N)** chip in the header lists games from the last 72 hours that are waiting: Confirm, Change… or No set build, or Dismiss all. Each game also shows the opponent's build. Every game page also has a **Build check-in** card where you can set or change the planned build, correct the opponent's build and edit your notes at any time. The desktop app's tray menu has **Build check-in…** to reopen a card you closed.",
      ],
    },
    {
      type: "paragraph",
      text: "Playing Random, or facing a Random opponent? There's no loading card because the matchup isn't known yet. You're asked after the game, with the real matchup.",
    },
    { type: "heading", text: "The opponent's build" },
    {
      type: "paragraph",
      text: "A game you already checked in shows a compact **Checked in** summary with the effective build, a corrected opponent build when present, and a short preview of a saved note. Press **Edit** to reopen the full card. Save or discard a changed note, then press **Done** to return to the summary. Games still waiting for a choice keep their full prompt; **Add new build…** links open the editor directly.",
    },
    {
      type: "paragraph",
      text: "The replay also names the build your opponent went for. When it got that wrong, correct it, and your own stats against that build (opponent history, how your builds do against each opener, the custom builds you saved for opponents) count the game under the build they really played.",
    },
    {
      type: "steps",
      items: [
        "**After the game, on the desktop card.** Once your replay has uploaded, the card shows **Opponent's build: …** with what the replay found. Click **Change**: the list switches to the opponent's builds, with the ones you've **Faced before** first, then **All builds** and a *Search opponent builds* box. Pick one and the row is marked **changed**; **Use replay's label** undoes it. The correction is saved with **Confirm**, **No set build** or **Done**.",
        "**On the website.** The game page's **Build check-in** card has an **Opponent's build: …** line. Press **Change…**, pick the build, then **Save**, or **Use replay's label** to go back to what the replay found. A corrected build carries a **Corrected** badge (hover it to see the replay's own label), on the card and next to *Opponent strategy* at the top of the page.",
      ],
    },
    { type: "heading", text: "Add a build you don't have yet" },
    {
      type: "paragraph",
      text: "Went for something new, or faced a build that isn't in the list? Save it as a custom build from the game itself, with the same editor as *Save as new build* on a game's build order, and it becomes this game's check-in in one go.",
    },
    {
      type: "steps",
      items: [
        "**On the desktop card**, click **Add new build…** under your builds or under the opponent's. It opens this game on sc2tools.com with the editor ready, and the card steps aside. It's available once your replay has uploaded.",
        "**On the website**, press **Change…** on either side of the game page's check-in card (or in the **Build check-ins (N)** list) and click **Add new build…** under the list. If your search found nothing, **Add “…” as a new build…** uses what you typed as the name. In the check-in list, the opponent's line has its own **Add new build…**.",
        "**Build it from the replay.** The editor shows this game's build order for that player: click **+** on the starred steps that define the build, check the live match preview, name it and press **Save build** (or **Save & re-match** to also match your older games). The race is set by the game; the vs race can be this game's or Any.",
        "**Done.** *Saved to your library and checked in* means the new build is in your library and counts for this game. If a build with that name already exists, you're asked to pick another name, so nothing is overwritten. If the game can't take a check-in, the build is still saved to your library.",
      ],
    },
    { type: "heading", text: "How it counts" },
    {
      type: "list",
      items: [
        "Only confirmed check-ins change your stats. Suggestions and randomizer rolls never do on their own.",
        "A confirmed check-in counts in your Build stats tab, build details, custom build library, MMR charts, trends and overlay widgets. **incl. N check-ins** shows how many games count only because of a check-in; those games carry a **Planned** badge with the replay's own label and your notes.",
        "Build timings, compositions and transitions only use games that actually followed the build, so a build's shape isn't diluted by games that went sideways.",
        "A corrected opponent build counts the same way: your own stats against that build include the game.",
        "Community guides, ladder meta and coaching keep the replay's own label, for your build and the opponent's. Your check-ins only change your own stats.",
        "Games under 45 seconds never count toward a build. **No set build** undoes a check-in.",
      ],
    },
    { type: "heading", text: "On stream" },
    {
      type: "paragraph",
      text: "The desktop cards are hidden from screen capture, so OBS display or window capture won't show them, and your pick is never sent to overlay widgets or chat commands. Viewers only see the randomizer reveal, or no reveal when you picked a build first.",
    },
    { type: "heading", text: "If something's missing" },
    {
      type: "list",
      items: [
        "**No card at the loading screen?** Check that the desktop app is running and up to date, that *Ask during the loading screen* is on, that StarCraft II isn't in exclusive Fullscreen, and that it's a 1v1 vs a human. Random games only ask after the game.",
        "**No card after the game?** *Ask after each game* must be on. If the replay uploads late (offline, or with replay capture on), check in from the header chip or the game page.",
        "**Randomizer rolled a few seconds late?** That's the short hold while you decide; *Roll now* skips it, and turning off *Ask during the loading screen* removes it.",
        "**No opponent's build or Add new build… on the desktop card?** Both need your replay, so they appear once it has uploaded (*Available once your replay uploads*). Until then, use the game page on the website.",
      ],
    },
  ],
  related: ["desktop-scouting", "dashboard-and-analyzer", "getting-started"],
};

export default article;
