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
    "check-ins",
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
    "macro breakdown",
    "change build",
  ],
  updated: "2026-10-27",
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
        "Open [Settings → Build check-in](/settings?tab=checkin). Three switches, all off by default: **Build check-ins** (the master switch), **Ask during the loading screen** and **Ask after each game**. Enable the prompts you want, then press Save. Existing saved choices are kept when updating.",
        "The desktop app's Settings tab has the same three switches, kept in sync with the website. Every card also has a quick link to stop asking (**Don't ask at loading**, **Turn off check-ins after games**).",
      ],
    },
    { type: "heading", text: "Use selectors inside Companion", anchor: "companion" },
    { type: "paragraph", text: "Use **Agent 0.24.1 or later** for the latest embedded selectors and Randomize control. Update through **Agent → Check for updates** or the [Windows download](/download). See [Desktop Companion](/help/desktop-companion)." },
    { type: "paragraph", text: "Open **Companion → Build selectors** in the Windows app to handle your build choices in the same workspace as scouting and Ghost. Game-screen assistance starts off. Turn **In-game assistance** on and select the individual features you want, including either build selector. You can turn these on or off whenever you want. The native selector works without an OBS source; [Desktop Companion](/help/desktop-companion) explains the shared workspace." },
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
        "**Build randomizer.** Click **Randomize** to select and save one build even without an open widget. A retry or another display reuses that saved result. Pick a build yourself to declare your own plan instead. Animation, sounds and spoken results stay in the separate browser or OBS widget. The saved roll can be suggested after the game for you to confirm.",
        "**After the game.** When the game ends, **Which build were you going for?** appears with a best guess already selected and a label saying why: you picked it at loading, it was the randomizer roll, it best matches your replay, it's your closest custom build, or it's your usual build for the matchup. *Replay classified as …* shows what the replay looked like. Press **Confirm**, pick a different build, choose **No set build** (you weren't going for anything in particular; the game keeps the replay's label) or **Later**. Use the notes box for what threw the build off. Ctrl+Enter confirms, Esc means Later. Once your replay has uploaded, the card also shows **Opponent's build** and **Add new build…** (see below).",
        "**Picked at loading?** If the replay matched your pick there's nothing to do. If it didn't, a short **What happened?** card asks for a note: **Done** keeps your pick, **Change build** switches it.",
        "**Missed one?** The **Build check-ins (N)** chip in the header lists games from the last 72 hours that are waiting: Confirm, Change… or No set build, or Dismiss all. Each game also shows the opponent's build. Every game page also has a **Build check-in** card where you can set or change the planned build, correct the opponent's build and edit your notes at any time. The desktop app's tray menu has **Build check-in…** to reopen a card you closed.",
      ],
    },
    {
      type: "paragraph",
      text: "Playing Random, or facing a Random opponent? There's no loading card because the matchup isn't known yet. You're asked after the game, with the real matchup.",
    },
    { type: "heading", text: "Correct an accidental selection", anchor: "change-build" },
    { type: "paragraph", text: "Open the game page, find **Checked in: …**, then select **Edit → Change…**, choose the correct build and press **Confirm**. You can also do this in **Macro Breakdown → Build selection → Change build**, including the popup opened from a macro score. **No set build** removes your planned choice so the game uses the replay's detected label again. A **Planned** badge identifies the saved check-in; its tooltip names the replay's detected build." },
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
        "**On the website**, the **Build check-ins (N)** list has **Add new build…** beside **Replay classified as …** for your own build. **Add opponent build…** on the opponent's line opens their replay steps instead. You can also press **Change…** and use **Add new build…** under your build list, or use either side of the game page's check-in card. If your search found nothing, **Add “…” as a new build…** uses what you typed as the name.",
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
    { type: "heading", text: "Plan survival", anchor: "plan-survival" },
    { type: "paragraph", text: "After at least **five confirmed declarations** for a build, its dossier shows **Plan survival** and build lists can show **Held**. Held means the replay detector named the declared build or recorded no different label. **Knocked off** means it recorded another build. This comparison describes labels; missing detection does not prove execution, and a different label does not prove that your opponent caused a change. Stable custom-build identity is used before a renamed display label." },
    { type: "paragraph", text: "The ring counts all confirmed declared games in the visible cohort. **Held win rate** and **Knocked-off win rate** each use their own decided-game count; missing results stay unknown rather than becoming losses. Ordinary detected games remain in Performance but do not inflate the declared denominator." },
    { type: "paragraph", text: "**Knocked into** ranks the five most common different detector labels. **Knocked by opponent strategy** ranks the opponent labels recorded in those same games, without claiming causality. A row opens at most 20 latest recorded examples, while its count still covers all matching declarations. The estimated median full game length describes games with a different label; it is not the time the plan changed. Hidden, deleted, pending-deletion and replay-resume tests do not contribute." },
    { type: "heading", text: "Grading a game", anchor: "grading-a-game" },
    { type: "paragraph", text: "On your own game page, **Build execution** checks your applied confirmed check-in, otherwise the recorded detected build. Custom builds show their current saved rules with observed counts. Catalog builds show timings only; zero rules have no grade. The card is private and never appears in coach, review, public replay or overlay pages." },
    { type: "paragraph", text: "**Observed** means the recorded count met a fixed rule; **Unmet** means it did not. **Unknown** means evidence or proxy classification could not be established. Any unknown rule withholds the overall percentage and replay rail match chip. Otherwise the percentage is passing rules divided by all saved rules. It does not judge your decisions or explain the result." },
    { type: "paragraph", text: "Rules count events **strictly before** a deadline. **At** chips seek the required positive occurrence or first excess event. **Deadline** chips describe an absence, shortfall or completed window; they do not claim an action occurred there. Every chip seeks the same paused replay clock. Units, morphs and upgrades use the editor/classifier's same era-aware construction-start conversion." },
    { type: "paragraph", text: "**Key timings vs your usual** shares one sample of up to 25 eligible dossier games with the timeline. Exact owner build identity and matchup are preserved. Private comparisons appear after **three observations of that milestone**; two stay unavailable. Public and Community floors stay unchanged. Rows show this start, median, p25–p75 middle half, n and earlier/later delta. Natural is the first town hall after 0:10; first gas and first tech name the observed structure. Later repeats get no duplicate comparison." },
    { type: "paragraph", text: "**Practice this build** reuses Ghost controls with this replay's recorded steps; a custom build can prefer your saved reference. Only an explicit Practice action arms a target. Missing own logs do not trigger a baseline sample. Missing definitions never fall back to same-name builds. Retry handles temporary failures; reanalysis, log replacement, edits and visibility changes invalidate cached evidence." },
    { type: "heading", text: "On stream" },
    {
      type: "paragraph",
      text: "The check-in cards request Windows capture exclusion, but capture tools and modes can behave differently. Verify your own setup before displaying private notes. Declared build names are not sent in overlay build-intent events or chat commands. Randomize saves the shared selection; its animated reveal, sound effects and speech stay in the widget. Native scouting speech is independent and unaffected.",
    },
    { type: "heading", text: "If something's missing" },
    {
      type: "list",
      items: [
        "**No card at the loading screen?** Check that the desktop app is running and up to date, that *Ask during the loading screen* is on, that StarCraft II isn't in exclusive Fullscreen, and that it's a 1v1 vs a human. Random games only ask after the game.",
        "**No card after the game?** *Ask after each game* must be on. If the replay uploads late (offline, or with replay capture on), check in from the header chip or the game page.",
        "**Randomizer waiting?** Click **Randomize** in check-in to select and save a build; the widget does not need to be open. A failed request shows a message and allows retry. Check the current matchup's enabled pool and your connection.",
        "**No opponent's build or Add new build… on the desktop card?** Both need your replay, so they appear once it has uploaded (*Available once your replay uploads*). Until then, use the game page on the website.",
      ],
    },
  ],
  related: ["desktop-companion", "desktop-scouting", "dashboard-and-analyzer", "getting-started"],
};

export default article;
