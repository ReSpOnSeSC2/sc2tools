# Median Key Timings — Implementation Prompt List

A sequenced list of prompts to upgrade the Median Key Timings feature in both
the SPA web browser (`stream-overlay-backend/public/analyzer/index.html`) and
the SC2Replay-Analyzer desktop app (`SC2Replay-Analyzer/ui/app.py`), backed by
matchup-aware data from both copies of `analytics/opponent_profiler.py`.

Goals across all prompts:
- Show only buildings relevant to the matchup that was actually played
  (e.g. PvZ never shows Barracks).
- Use the real building icons already on disk
  (`SC2-Overlay/icons/buildings/*.png`).
- Pull from `opp_build_log` (opponent's actual structures) when present, and
  fall back to the user's `build_log` only for buildings of the user's own
  race.
- Add detail (range, p25/p75, sample count, last-seen, win-rate-when-built,
  trend arrow) and interactivity (hover tooltip, click-to-drill-into-games,
  matchup filter pills).
- No regressions: every field and column the current views surface must still
  be available.
- Production quality only — no placeholders, no `// TODO`, no mock data, real
  error states, accessible markup, keyboard navigation, and graceful no-data
  fallbacks.

Run the prompts in order. Each one is self-contained and references concrete
files and line numbers so you don't have to repaste context.

---

## Prompt 1 — Build the matchup-aware token catalog (shared data layer)

> Create a new shared module `analytics/timing_catalog.py` (add a copy in
> `C:\SC2TOOLS\reveal-sc2-opponent-main\analytics\` AND in
> `C:\SC2TOOLS\SC2Replay-Analyzer\analytics\`) that exposes:
>
> 1. `RACE_BUILDINGS: Dict[str, List[TimingToken]]` — for each race (`Z`, `P`,
>    `T`), the canonical ordered list of key-timing buildings. Each
>    `TimingToken` is a dataclass with: `token` (substring used by the
>    existing `_TIMING_RE` matcher, e.g. `"Pool"`), `display_name` (e.g.
>    `"Spawning Pool"`), `internal_name` (e.g. `"SpawningPool"` — exact
>    sc2reader name for downstream use), `icon_file` (lowercase filename
>    matching `SC2-Overlay/icons/buildings/*.png`, e.g. `"spawningpool.png"`),
>    `tier` (1=tech opener, 2=tech switch, 3=late tech), and `category`
>    (`"opener"`, `"production"`, `"tech"`, `"expansion"`, `"defense"`).
> 2. `relevant_tokens(my_race: str, opp_race: str) -> List[TimingToken]` —
>    returns the union of tokens for both races in canonical display order
>    (own race first, opponent second). Accepts `"P"`, `"Protoss"`, lowercase,
>    etc. Returns an empty list if either race is unknown.
> 3. `matchup_label(my_race, opp_race) -> str` — returns `"PvZ"`-style label.
>
> Cover every Z/P/T building that has an icon at
> `SC2-Overlay/icons/buildings/`. Include at minimum:
> - Z: Hatchery, SpawningPool, Extractor, EvolutionChamber, RoachWarren,
>   BanelingNest, Lair, HydraliskDen, LurkerDen, Spire, InfestationPit, NydusNetwork,
>   Hive, UltraliskCavern, GreaterSpire.
> - P: Nexus, Pylon, Assimilator, Gateway, Forge, CyberneticsCore,
>   PhotonCannon, ShieldBattery, TwilightCouncil, RoboticsFacility, Stargate,
>   TemplarArchive, DarkShrine, RoboticsBay, FleetBeacon.
> - T: CommandCenter, SupplyDepot, Refinery, Barracks, EngineeringBay,
>   Bunker, MissileTurret, Factory, GhostAcademy, Starport, Armory,
>   FusionCore, PlanetaryFortress.
>
> Add a `__test__` block at the bottom that, when run with
> `python -m analytics.timing_catalog`, asserts every `icon_file` actually
> exists under `SC2-Overlay/icons/buildings/` (search both repos' icon
> folders) and prints any missing icons. Treat a missing icon as a hard
> failure — do not ship with broken image paths.
>
> Keep both copies byte-identical so the desktop app and the web SPA share
> the same canonical taxonomy. Add a top-of-file comment instructing the
> reader to keep the two copies in sync.

---

## Prompt 2 — Rewrite `_compute_median_timings` to be matchup-aware and richer

> In **both** `analytics/opponent_profiler.py` files
> (`C:\SC2TOOLS\reveal-sc2-opponent-main\analytics\opponent_profiler.py` and
> `C:\SC2TOOLS\SC2Replay-Analyzer\analytics\opponent_profiler.py`), replace
> `_compute_median_timings` and `_empty_timings` with a richer version. The
> new contract:
>
> Input: `games: List[Dict]`, plus `my_race: str` (already accepted by
> `profile()`).
>
> For each game, derive the per-game matchup from `g.get("opp_race")` and
> `my_race`. Use `analytics.timing_catalog.relevant_tokens(my_race, opp_race)`
> to determine which tokens are eligible *for that game*. A token is only
> appended to its sample list if it is relevant for the game's matchup.
>
> For each token, source the timing from:
> 1. `opp_build_log` (opponent's real buildings) if the token is an
>    opponent-race token.
> 2. `build_log` (user's buildings) if the token is the user's-race token.
> 3. Skip silently otherwise.
>
> For each surviving token, compute:
> - `sample_count`
> - `median_seconds`, `median_display` (`"M:SS"`)
> - `p25_seconds`, `p75_seconds` and their `"M:SS"` displays
> - `min_seconds`, `max_seconds`, `min_display`, `max_display`
> - `last_seen_seconds` and `last_seen_display` (most recent game)
> - `win_rate_when_built` (float in `[0, 1]`) — wins among games where the
>   token appeared / total games where it appeared
> - `trend` — string, one of `"earlier"`, `"later"`, `"stable"`, `"unknown"`
>   based on a Mann-Kendall-lite comparison of the first half of samples
>   (chronological) vs the second half. `"unknown"` when `sample_count < 4`.
> - `source` — `"opp_build_log"` or `"build_log"` so the UI can label the
>   provenance honestly.
>
> Return a `Dict[str, Dict]` keyed by token in the order returned by
> `relevant_tokens(my_race, modal_opp_race)`, where `modal_opp_race` is the
> most common opponent race across `games` (fall back to the only race if
> there's just one). Tokens with `sample_count == 0` are still present so
> the UI can show "no data" cards in stable matchup-relevant slots.
>
> Update `_empty_timings()` to return the same shape with all numeric fields
> set to `None` and display fields set to `"-"`, sourced from the same
> `relevant_tokens()` call (when `my_race` is unknown, return an empty dict).
>
> Update `profile()` so the returned `median_timings` field is keyed by
> `internal_name` (`"SpawningPool"`, `"RoboticsFacility"`) AND carries an
> ordered list `median_timings_order` of internal names so the UI never
> has to re-derive ordering. Also add `matchup_label` and `my_race` /
> `opp_race_modal` to the profile payload for the UI to display.
>
> Do not change any other field names already in `profile()` — the existing
> consumers must continue to work. Add unit tests in
> `analytics/_test_timings.py` covering: PvZ filters out Barracks, ZvT
> includes Barracks for opponent and Hatchery for self, empty input yields
> empty timings, single-game input yields `trend == "unknown"`,
> percentiles round to integer seconds, and `win_rate_when_built` matches a
> hand-computed example.

---

## Prompt 3 — Wire the SPA `MedianTimingsGrid` to the new payload

> In `C:\SC2TOOLS\reveal-sc2-opponent-main\stream-overlay-backend\public\analyzer\index.html`,
> rewrite the `MedianTimingsGrid` component (currently at lines 1652-1672) and
> the surrounding `Card title="Median key timings ..."` block (~line 2035).
>
> Requirements:
> - Replace the hardcoded `ORDER` array with `timings_order` from the
>   profile payload (Prompt 2). Never show a building that isn't in that
>   list.
> - Title becomes `"Median key timings — ${matchup_label}"` and the helper
>   subtitle reflects provenance per token (e.g.
>   `"opponent's structures (sc2reader)"` vs
>   `"your build (proxy for matchup tendencies)"`).
> - Each card shows:
>   - Building icon at the top-left, sourced from
>     `/analyzer/../../icons/buildings/${icon_file}` (resolve the static
>     path the SPA already uses for race icons; if there's no resolver,
>     add one named `buildingIconUrl(internal_name)` and reuse it across
>     the file).
>   - Display name (full, e.g. `"Spawning Pool"`).
>   - Median time as the hero number, with p25-p75 range underneath in a
>     muted secondary line (e.g. `"3:21 — 4:05"`).
>   - Sample count badge (e.g. `"n=12"`).
>   - Tiny win-rate-when-built pill (color-graded green/amber/red).
>   - Trend arrow icon (▲ later / ▼ earlier / – stable / · unknown) with
>     an aria-label.
> - Empty cards (sample_count === 0) render with a dimmed icon and a
>   "no samples" subline; they are still keyboard-focusable.
> - Cards are interactive:
>   - Hover/focus → tooltip with min, max, last-seen, source provenance,
>     and the underlying matchup count.
>   - Click → opens a side drawer (or modal — pick whichever pattern the
>     SPA already uses, look for an existing `<Drawer>`/`<Modal>`
>     component first, e.g. the existing CSV/Filter dialogs) listing every
>     game that contributed to this token's timing, sorted newest first,
>     with map, date, my-race vs opp-race, the timestamp for that token,
>     win/loss badge, and a link/button to open the full game detail card
>     that already exists elsewhere in the SPA.
> - Layout: CSS grid, `repeat(auto-fill, minmax(180px, 1fr))`, gap 8px.
>   On narrow viewports collapse to a single column. Match the existing
>   `bg-base-700 ring-soft rounded-lg` card style for visual consistency.
> - Add a small toolbar above the grid with two pills:
>   `[ Opponent's tech ] [ Your tech ]` that filter the grid by `source`.
>   Default = both shown. Persist the choice in `localStorage` under
>   `analyzer.timings.sourceFilter`.
> - Add an `aria-live="polite"` summary line that updates whenever the
>   matchup or the source filter changes (e.g.
>   `"Showing 7 of 9 timings for PvZ — opponent tech only"`).
>
> Do not remove the existing `EmptyState` fallback nor the
> `ErrorBoundary` wrapper. Keep the existing `data-testid` attributes if
> any. Verify by opening the SPA and navigating to an opponent profile —
> the grid must render with no console errors and no broken images.

---

## Prompt 4 — Rebuild the SC2Replay-Analyzer Opponents tab timings card

> In `C:\SC2TOOLS\SC2Replay-Analyzer\ui\app.py`, replace the median-key-
> timings rendering inside `_render_opponents_tab` (currently around lines
> 1582-1605) with a richer card-grid layout. Mirror what Prompt 3 does on
> the web side, adapted to CustomTkinter:
>
> - Pull `timings`, `median_timings_order`, and `matchup_label` from the
>   profile payload.
> - Section header reads `f"Median key timings — {matchup_label}"`. The
>   small-print sub-line reads
>   `f"Opponent tech parsed from opp_build_log; your tech from build_log."`
>   No more `"opponent timings unavailable"` blanket caveat — the new
>   profiler distinguishes per token via the `source` field.
> - Render a responsive grid of building cards using a single
>   `CTkScrollableFrame` parent. For each token in `median_timings_order`:
>   - Load the building icon from
>     `os.path.join(ICONS_DIR, "buildings", token.icon_file)`. Add an
>     `ICONS_DIR` constant near the top of `ui/app.py` resolved relative
>     to the project root (`Path(__file__).resolve().parents[1] /
>     "SC2-Overlay" / "icons"` — adjust to whatever resolver the project
>     already uses; if neither repo's path is reachable from the desktop
>     install, add a config entry `icons_dir` to `config.json` and let it
>     override).
>   - Use `CTkImage` with `light_image=Image.open(...).convert("RGBA")`
>     sized to `(40, 40)`. Cache loaded `CTkImage` instances in
>     `self._timing_icon_cache` keyed by `internal_name` so they survive
>     tab re-renders.
>   - Card body: display name (FONT_BOLD), median time (FONT_LARGE),
>     `p25–p75` range (FONT_SMALL grey), `n=…` (FONT_SMALL grey),
>     win-rate-when-built pill (color-coded), trend arrow.
>   - Empty cards (sample_count == 0) render dimmed with subtitle
>     `"no samples in this matchup"`.
>   - Each card binds `<Button-1>` to a handler that opens a modal
>     `_open_timing_drilldown(token, opp_name)` showing every game that
>     contributed, sorted newest first, with the same fields the web
>     drawer shows. Reuse the existing modal/dialog pattern in
>     `app.py` (search for `_open_*_modal` or `CTkToplevel` to find it);
>     don't introduce a new dialog framework.
>   - Bind `<Enter>` / `<Leave>` to a tooltip showing min/max/last-seen.
>     If the file already has a `Tooltip` helper class, reuse it; if not,
>     add a small one in `ui/_tooltip.py` rather than inlining a copy in
>     `app.py`.
> - Above the grid, add two `CTkSegmentedButton` filter chips
>   `["Both", "Opp tech", "Your tech"]`. Persist the selection in the
>   existing `self._opp_ui_state` dict (or whatever per-tab state dict the
>   file uses; search for `_state` near `_render_opponents_tab`).
> - Keep the existing "if no rows, show
>   `'(no key building timings yet)'`" fallback, but trigger it only when
>   *every* token has `sample_count == 0` after filtering.
> - All other Opponent-tab sections (top strategies, map performance,
>   last-5, build-order viewer) must stay untouched. Confirm by running
>   the app and clicking through each section.
>
> Add a small smoke test in `analytics/_test_timing_cards_smoke.py` that
> instantiates a hidden `Tk` root, calls into the profile builder with a
> fixture, and asserts the rendered widget tree has the expected number
> of card frames per matchup.

---

## Prompt 5 — Mirror the changes in `reveal-sc2-opponent-main/gui/analyzer_app.py`

> The reveal-sc2-opponent project ships its own desktop GUI at
> `C:\SC2TOOLS\reveal-sc2-opponent-main\gui\analyzer_app.py`, which already
> calls `_render_opp_timings_card(prof)` (around line 2180). Apply the same
> upgrades described in Prompt 4 to that file:
>
> - Same matchup-aware filtering, same card layout, same icons (this repo's
>   `SC2-Overlay/icons/buildings/` path is local — no config entry needed),
>   same drilldown modal, same source filter chips.
> - Reuse `analytics.timing_catalog` (the copy you placed in this repo's
>   `analytics/` directory in Prompt 1) and the upgraded
>   `analytics/opponent_profiler.py` (Prompt 2).
> - Match this app's existing visual rhythm: same paddings, same font
>   constants, same color tokens. Look at the surrounding methods
>   (`_render_opp_build_order_card`, `_render_opp_maps_card`,
>   `_render_opp_last5_card`) for cues.
> - Don't touch `_render_opp_build_order_card` — that section already
>   correctly prefers `opp_build_log` for the build-order viewer; just make
>   sure the timings grid uses the same data source resolution rule.
>
> Verify by launching `python -m gui.analyzer_app`, opening a known
> opponent with mixed-race history, and confirming each matchup tab shows
> exactly the right buildings.

---

## Prompt 6 — Add a per-matchup sub-tab when an opponent has multiple races

> In both desktop apps and the SPA, when an opponent has played multiple
> races against the user, the timings card should expose a small
> matchup-selector at the top: e.g. `[ All  PvZ (8)  PvT (3)  PvP (1) ]`.
> Default selection = "All" (which uses the modal opponent race for
> ordering, as in Prompt 2). Selecting a specific matchup re-runs
> `_compute_median_timings` over the games filtered to that matchup.
>
> Implementation notes:
> - Add `_compute_median_timings_for_matchup(games, my_race, opp_race)` as
>   a thin wrapper in `opponent_profiler.py`.
> - In the SPA, add the selector as a row of `<button>`s above the grid,
>   styled like the existing matchup pills used elsewhere in the analyzer
>   (search for `byMatchup` rendering near line 826 — match that look).
> - In the desktop apps, use `CTkSegmentedButton`.
> - Persist the selection per-opponent in
>   `analyzer.timings.matchup[<opp_name>]` for the SPA (localStorage) and
>   in `self._opp_ui_state[opp_name]["matchup"]` for desktop.
> - Update the `aria-live` / status-bar summary to reflect the active
>   matchup count.
>
> Don't break the "All" view — it must still feel like the default
> experience, just with smarter ordering and filtering than today's
> hardcoded list.

---

## Prompt 7 — Drilldown drawer/modal: list of contributing games

> Build the drilldown surface that Prompts 3 and 4 reference. Keep one
> shared spec across web and desktop:
>
> Header: building icon, display name, current matchup label, sample count,
> median + p25/p75 + min/max line.
>
> Body: a virtual-scrolling list (web: `react-window` if already a dep —
> search `package.json`; otherwise plain windowing with
> `IntersectionObserver`) of game rows. Desktop: `CTkScrollableFrame` with
> lazy row creation in chunks of 50.
>
> Each row:
> - Date (relative + absolute on hover)
> - Map name
> - My race vs Opp race
> - The timestamp this token was first observed in that game
>   (`M:SS`)
> - Win/Loss pill
> - Source badge (`opp_log` / `my_log`)
> - Click target → opens the existing full-game detail view that the app
>   already has (web: `setActiveGame(id)` if such a setter exists; desktop:
>   call into the build-order viewer card with the game's id).
>
> Footer: a tiny export button — "Copy timings to clipboard" (writes a
> Markdown table) — and a "Close" button. Web: trap focus inside the
> drawer; desktop: `dialog.transient(self)` + `grab_set()`.
>
> Empty state: if a token has `sample_count == 0`, the card stays
> non-interactive (no drilldown). Don't open an empty modal.

---

## Prompt 8 — Final QA pass: production polish

> Final review pass across both apps and the shared module. Confirm and
> fix as needed:
>
> 1. **No mock/fake data anywhere.** If a value can't be derived from real
>    games, render `"-"` (or the dimmed empty card), never a placeholder
>    number. Cross-check against the recent session-MMR fix that uses
>    `"xD"` as the honest no-data sentinel — the same philosophy applies
>    here. (Use `"-"` here; `"xD"` is a session-widget specific
>    convention.)
> 2. **No unhandled exceptions** when `opp_race` is missing, when
>    `build_log` is empty, when icons are missing on disk (log-and-skip,
>    don't crash). Add a defensive `try/except` around per-token rendering
>    in both UIs and pipe failures into the existing error logger
>    (`core.error_logger.ErrorLogger` for the desktop app).
> 3. **Accessibility (web):** every interactive card has `role="button"`,
>    `tabindex="0"`, `aria-label` describing the building and median, and
>    handles Enter/Space. Color contrast ≥ 4.5:1 against the card
>    background for all text. Focus rings visible.
> 4. **Accessibility (desktop):** every card responds to keyboard focus
>    (use `bind("<FocusIn>")` to mirror the hover state). The matchup and
>    source segmented buttons are reachable by Tab.
> 5. **Performance:** profile builder runs in `O(games × tokens)` time —
>    confirm no quadratic regression. Memoize `relevant_tokens()` results.
>    Web grid renders ≤ 16ms for 30 cards (use the React Profiler).
> 6. **Tests pass:** `python -m analytics._test_timings`,
>    `python -m analytics._test_timing_cards_smoke`,
>    `python -m analytics.timing_catalog` (the icon-existence check).
> 7. **No removed functionality.** Diff the before/after of:
>    `MedianTimingsGrid` (web), `_render_opponents_tab` timings section,
>    `_render_opp_timings_card`. Every previously-shown field must still
>    be present (just possibly relocated). The build-order viewer, top
>    strategies, map stats, last-5 games, and CSV export must all still
>    work.
> 8. **Visual:** open both desktop apps and the SPA, screenshot the new
>    timings card for a PvZ, ZvT, and TvT opponent, and confirm zero
>    irrelevant buildings appear in any matchup.
> 9. **Sync check:** the two copies of `analytics/timing_catalog.py` and
>    the two copies of `analytics/opponent_profiler.py` are byte-identical
>    aside from the top-of-file comment. Add a tiny CI script
>    `scripts/check_shared_modules.py` that diffs them and exits non-zero
>    on drift.
>
> Ship only when all nine items are green.

---

## Optional follow-ups (nice-to-have, not blocking)

- **Prompt 9 — Compare-to-ladder overlay.** When the analyzer DB has
  enough games against ANY opponent of a given race, show a faint ghost
  marker on each card representing the global median for that
  matchup-token. Lets the user see "this opponent is faster than average
  to Lair by 18s".
- **Prompt 10 — Timing scrub bar.** For interactive scrubbing across the
  matchup, replace the static cards with a horizontal timeline (0:00 →
  game-end median) where each token is a draggable pin. Click a pin to
  open the same drilldown.
- **Prompt 11 — Export to clipboard / image.** "Copy as Markdown" and
  "Save as PNG" actions for the whole matchup-timings card so you can
  drop it into Discord/notes.
