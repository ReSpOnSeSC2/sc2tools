# SC2 Overlay - Per-Widget Browser Sources

Each `.html` file in this folder is a **single, independently-positionable
widget**. Add each one as its own OBS Browser Source, then drag/resize it
to wherever you want on your stream.

This is the recommended setup for most streamers — the all-in-one
`SC2-Overlay/index.html` exists for testing or for users who want
everything pinned in one fixed layout.

## How to add a widget to OBS

1. In OBS, **Sources panel → + → Browser**.
2. **URL** — point it at the widget's local file. Example:
   ```
   file:///C:/SC2TOOLS/reveal-sc2-opponent-main/SC2-Overlay/widgets/session.html
   ```
3. **Width / Height** — pick whatever fits the widget. Suggested starting sizes:
   - Session, MMR delta, Meta:           300 x 100
   - Top builds:                         320 x 240
   - Match result, Rematch, Cheese:      400 x 130
   - Favorite opening, Best answer:      400 x 130
   - Scouting report (consolidated):     500 x 280
   - Rival alert:                        420 x 130
   - Post-game reveal (with timeline):   500 x 220
   - Streak splash:                      600 x 200
   - Rank up/down:                       400 x 130
   - Opponent detected:                  400 x 110
4. **Background**: leave the OBS source background transparent. The widget
   pages set `background: transparent` themselves; OBS picks that up.
5. Click OK, then drag the source to where you want it on your scene.

## Available widgets

| File                      | What it shows                                          | When it shows           |
|---------------------------|--------------------------------------------------------|-------------------------|
| `session.html`            | W-L, MMR delta, league badge, session duration         | Always (persistent)     |
| `topbuilds.html`          | Your top 6 builds with W-L                             | Always (persistent)     |
| `match-result.html`       | Race vs race + VICTORY/DEFEAT + map + duration         | Post-game (~15s)        |
| `opponent.html`           | "Opponent detected: <name>"                            | Pre-game (~20s)         |
| `rematch.html`            | All-time record vs this opponent                       | Pre-game (~15s)         |
| `cheese.html`             | Cheese-history warning if you've cheesed or been cheesed | Pre-game (~18s)       |
| `fav-opening.html`        | Opponent's favorite opener (F1)                        | Pre-game (~18s)         |
| `best-answer.html`        | Your best historical answer to that opener (F2)        | Pre-game (~18s)         |
| `scouting.html`           | Consolidated card with everything above (recommended over the four above) | Pre-game (~22s) |
| `rival.html`              | Special pop-up for opponents with 5+ all-time games    | Pre-game (~16s)         |
| `post-game.html`          | What the opponent actually did + animated build timeline (F3) | Post-game (~16s) |
| `meta.html`               | Most-faced opponent strategy this session (F5)         | Post-game (~12s)        |
| `mmr-delta.html`          | "+25 MMR" / "-30 MMR" pop-up                           | Post-game (~10s)        |
| `rank.html`               | Rank up / rank down notification                       | Post-game (~12s)        |
| `streak.html`             | "ON FIRE", "RAMPAGE", etc. center splash               | Post-game (~8s)         |

## Recommended starter set

If you want a minimal but high-impact layout, add just these four:

1. **session.html** — top-center or anywhere visible on screen
2. **scouting.html** — top-center for pre-game info
3. **post-game.html** — top-center for after games (replaces match-result if you want the build timeline)
4. **streak.html** — center-screen splash

The session and scouting widgets cover 90% of viewer engagement; the post-game
reveal animates your strategy detection; streak splashes catch hot/tilted moments.

## Custom positioning

Two ways to position each widget:

* **In OBS** — drag the Browser Source rectangle anywhere on the canvas, resize freely. The widget fills its source.
* **In CSS** — if you want pixel-perfect tweaks across all widgets, edit `SC2-Overlay/widget-mode.css` (the file that activates when `?w=` is in the URL).

## Troubleshooting

* **Widget is empty / blank** — make sure the overlay backend is running
  (`stream-overlay-backend/index.js`). Without it, the widget connects to
  `localhost:3000` and gets no data. The session/topbuilds widgets log
  to the OBS Browser Source's right-click → Inspect console.

* **Icons don't show** — confirm the icon files exist at
  `SC2-Overlay/icons/<subfolder>/`. The `<img onerror>` fallback hides
  broken icons, so a missing icon just leaves an empty slot.

* **Styling looks off** — every widget page references `../styles.css`
  and `../widget-mode.css` via relative paths. Don't move the widget files
  out of `SC2-Overlay/widgets/` without updating those paths.

* **Two widgets at once on one source** — ?w= mode is single-widget. If
  you want a multi-widget layout, use the all-in-one `SC2-Overlay/index.html`
  instead.
