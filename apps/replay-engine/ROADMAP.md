# SC2 Meta Analyzer — "Wow Features" Roadmap

Six features, sequenced by dependency and ROI. Each phase has a self-contained prompt at the bottom you can paste directly into an agent.

---

## Sequencing logic

The features share more infrastructure than they look like they do. Building them in the right order saves rework:

- **#3 (Opponent DNA)** is a pure aggregation over the existing `meta_database.json`. Zero dependencies. Ship first for momentum.
- **#7 (Macro Score)** forces you to build a *feature extraction layer* — ability events (inject/chrono/MULE), supply-blocked windows, idle production. That same layer feeds #6 and #8.
- **#6 (Win Probability)** and **#8 (ML Clustering)** both need per-minute feature vectors. Build the vectors once, use them twice.
- **#4 (Mini-map Playback)** and **#9 (Spatial Heatmaps)** share a map-rendering canvas. The heatmap is just an aggregated overlay on top of the playback canvas.

---

## Phase 0 — Foundation (1–2 days)

Before any feature work, do this small refactor. It will pay back five times over.

**Goals:**
- Split `SC2ReplayAnalyzer.py` (~2k lines, hard to reason about) into a package: `core/`, `analytics/`, `ui/`.
- Add an `analytics/feature_extractor.py` stub — every later feature writes into this.
- Bump `meta_database.json` schema version (e.g. add a `"_schema_version": 2` key) and write a migration helper so you can add fields without breaking older DBs.
- Add `numpy`, `pandas`, `scikit-learn` to a `requirements.txt`. Keep matplotlib optional as it already is.

**Prompt — Foundation refactor**

> Refactor `C:\SC2TOOLS\SC2Replay-Analyzer\SC2ReplayAnalyzer.py` into a package without changing any user-facing behavior. Create:
> - `core/` — `replay_loader.py` (sc2reader wrapper + load-level fallback from lines 750–814), `event_extractor.py` (lines 630–745), `error_logger.py` (class from line 909).
> - `analytics/` — empty `__init__.py`, plus a stub `feature_extractor.py` with a `class GameFeatures` dataclass and an `extract_features(replay, my_pid) -> GameFeatures` placeholder. Document in the docstring that this is the shared feature layer used by macro-score, win-probability, and clustering.
> - `detectors/` — `base.py` (BaseStrategyDetector, lines 219–264), `opponent.py` (OpponentStrategyDetector, lines 266–489), `user.py` (UserBuildDetector, lines 491–624).
> - `ui/` — `app.py` (App class), `visualizer.py` (GameVisualizerWindow), `theme.py` (color constants, font tuples).
> - `db/` — `database.py` (ReplayAnalyzer class), plus a `migrations.py` that reads `meta_database.json`, checks for `_schema_version`, and adds it if missing.
> - Keep `SC2ReplayAnalyzer.py` as a thin entry point that just imports `ui.app.App` and runs it. Verify the app still launches and parses a replay end-to-end.
> - Add `requirements.txt` with: `customtkinter`, `sc2reader`, `matplotlib`, `numpy`, `pandas`, `scikit-learn`, `Pillow`.

---

## Phase 1 — Opponent DNA Profiler (3–5 days)

**Why first:** zero new data needed, ships visible value in days, validates the new package layout.

**Scope:**
- Aggregate by `opponent.name` across the entire DB.
- Compute: build distribution (top 5 strategies + frequencies), W/L vs them, race-by-race tendencies, median key-building timings (Pool/Gateway/Rax/Robo/Stargate/Spire), map preferences and W/L per map, time-of-day patterns (cheese-hour detection — fun touch), recency-weighted "what did they do last 5 games."
- Fuzzy name matching: handle clan tag changes (`[Clan]Name` vs `Name`), Battlenet barcode collisions, character casing.
- UI: new "Opponents" tab in the sidebar, list sorted by games-played-vs, click → detailed profile panel.
- Pre-game popup: optional "Watch Replay Folder" mode that detects when you queue (read SC2 lobby logs or the `Bank` files), and if the opponent name matches one in your DB, pops a tooltip-style HUD with the top 3 things they tend to do.

**Prompt — Opponent DNA Profiler**

> Implement an Opponent DNA Profiler feature in the SC2 Meta Analyzer. The DB is `meta_database.json` (structure: top-level keys are build names, each contains `{games: [...], wins, losses}`; each game has `opponent`, `opp_race`, `opp_strategy`, `map`, `result`, `date`, `game_length`, `build_log`, `file_path`).
>
> Build:
> 1. `analytics/opponent_profiler.py` with a `OpponentProfiler(db)` class. Methods:
>    - `list_opponents(min_games=1) -> List[Dict]` returning name, total games, wins, losses, last_seen, with fuzzy-merged clan-tag aliases (use `difflib.SequenceMatcher` ratio >= 0.85, or strip `[...]` clan tags before grouping).
>    - `profile(name) -> Dict` returning: total record, race distribution they play, top 5 most-used `opp_strategy` values with counts, win-rate against each strategy, map list with W/L per map, median key-timing extracted from `build_log` (regex `[m:ss] BuildingName`) for Pool/Gateway/Barracks/Hatchery/Nexus/CommandCenter/Robo/Stargate/Spire/Twilight/Forge, last-5-games summary.
>    - `predict_likely_strategies(name, my_race) -> List[Tuple[str, float]]` — recency-weighted (last 10 games weight 2x) probability distribution.
> 2. Add an "Opponents" tab in the sidebar (`ui/app.py`). Left pane: scrollable list of opponents with games count badge. Right pane: profile detail rendered as cards — Overview, Build Tendencies (matplotlib bar chart of strategy %), Map Performance (table), Median Timings (table), Last 5 Games (mini timeline).
> 3. Wire a "Refresh Profiles" button. Cache the profile dict on the analyzer with invalidation when `save_database` is called.
>
> Test against a DB with 50+ games and at least 5 distinct opponents. Make sure clan-tag merging works on synthetic test data with `[XYZ]Player` and `Player` as the same person.

---

## Phase 2 — Macro Efficiency Score (1–2 weeks)

**Why second:** builds the feature-extraction infrastructure that #6 and #8 reuse. Pay the tax once.

**Scope:**
- Capture ability events from `replay.events` that aren't currently tracked: `InjectLarva` (Zerg), `Chronoboost` (Protoss), `CalldownMULE` (Terran).
- Capture supply-blocked windows from `PlayerStatsEvent.food_used >= food_made - 1` over time.
- Track idle production: for each production building, walk the unit-born events and find gaps > 8s.
- Compute a 0–100 macro score with weighted leak penalties.
- Output the top 3 leaks ranked by estimated lost resource value (mineral-equivalent).

**Prompt — Macro Efficiency Score**

> Implement a Macro Efficiency engine for the SC2 Meta Analyzer in `analytics/macro_score.py`. Use `sc2reader` events (already imported in `core/event_extractor.py`).
>
> 1. Extract these new event types alongside the existing ones (modify `core/event_extractor.py` to optionally return them — keep backward compat):
>    - `AbilityEvent` filtered to: `InjectLarva`, `ChronoBoostEnergyCost`, `CalldownMULE` (sc2reader exposes ability names; check `event.ability_name`).
>    - All `PlayerStatsEvent` rows for the player (you already grab these in `extract_graph_data`; consolidate).
>    - Production-building completion times by walking `UnitDoneEvent` for `Barracks/Factory/Starport/Gateway/RoboticsFacility/Stargate/Hatchery/Larva`.
>    - Unit-from-production-building events for idle-time detection.
>
> 2. Compute leaks:
>    - `supply_blocked_seconds`: sum of intervals where `food_used >= food_made - 1` and `food_used < 200`.
>    - `idle_production_seconds`: per production building, sum gaps > 8s after first unit produced, until building is destroyed or game ends.
>    - `missed_injects` (Zerg): expected_injects = floor(game_length / 29) per Hatchery alive; actual = count of `InjectLarva` ability uses; report missed.
>    - `chrono_waste` (Protoss): for each Nexus alive, expected = floor(seconds_alive / 20) chronos available; report unused chronos > 3 at once held.
>    - `mule_waste` (Terran): per OrbitalCommand, expected_mules = floor(seconds_alive / 64); report missed.
>    - `mineral_float_spikes`: count of PlayerStatsEvent samples where `minerals_current > 800` after game-time 4:00.
>    - `worker_oversaturation`: workers per base > 22 sustained 60s+.
>
> 3. Estimate resource cost for each leak (rough constants — supply blocked = 10 min/sec lost, missed inject = 75 min equiv (3 larvae), chrono missed = 50 min equiv etc) and produce `top_3_leaks` sorted by estimated mineral cost.
>
> 4. Macro score = `100 - sum(weighted penalties)`, clamped 0–100. Document the weights in a docstring.
>
> 5. UI: in `GameVisualizerWindow`, add a "Macro Report" section above the existing graphs. Big number (0–100) colored green/yellow/red. Below: bullet list of top 3 leaks with seconds/count and estimated mineral cost.
>
> 6. Persist `macro_score` and `top_3_leaks` into `game_data` in `process_replay_task` so they're saved to the DB. Add a "Macro" sortable column to the games table.
>
> Test against 5 known good replays (high APM pro replay should score 80+, your own messy ladder game should score 40–60).

---

## Phase 3 — Win Probability Curve + ML Clustering (2 weeks)

These two share the same per-minute feature-vector pipeline. Build the pipeline once.

**Scope:**
- Per-minute snapshot vectors: `{minute, supply_diff, income_diff_min, income_diff_gas, army_value_diff, base_count_diff, tech_path_one_hot, matchup_one_hot}`.
- Train a logistic regression on the user's full DB (need minimum 50 games or fall back to a pre-bundled prior trained on a generic ladder dataset).
- For #6: at predict-time, evaluate the model at each minute and plot P(win).
- For #8: take the *aggregated game-level* feature vector (early/mid/late summary), run k-means with k=4–6, name clusters using each centroid's distinctive features.

**Prompt — Win Probability Curve**

> Implement a per-game Win Probability Curve in `analytics/win_probability.py`.
>
> 1. Build a `SnapshotFeatureExtractor` that takes a parsed replay + my_pid and returns a pandas DataFrame with columns: `minute, supply_diff, income_min_diff, income_gas_diff, army_value_diff, nexus_count_diff, tech_score_self, tech_score_opp, matchup_PvT, matchup_PvZ, matchup_PvP` (one-hot only my matchups for now). Sample at every PlayerStatsEvent (~10s cadence) and resample to 1-minute bins via mean.
>
> 2. Build `WinProbabilityModel` with `train(db)` and `predict_curve(game_features) -> List[Tuple[minute, p_win]]`. Use `sklearn.linear_model.LogisticRegression` with `class_weight='balanced'`. Each training row = one (snapshot, win-label) pair. Persist trained model to `wp_model.pkl` next to the DB.
>
> 3. Cold-start: if DB has < 50 games with results, refuse to train and return None — UI should show "Need 50 games to train." Print games-needed in the UI.
>
> 4. Add a "Win Probability" graph to `GameVisualizerWindow` after the existing 3 graphs. X-axis = minutes, Y-axis = 0–100%, shade green > 50%, red < 50%, with a horizontal dashed line at 50%.
>
> 5. Add a "Train Model" button in the sidebar. Show last-trained timestamp and AUC on a holdout split.
>
> Test: build a synthetic DB of 100 games with strong supply-diff signal and verify the model converges and the curve is sensible.

**Prompt — ML Play-Style Clustering**

> Implement Play-Style Clustering in `analytics/clustering.py`. Reuses the snapshot extractor from `analytics/win_probability.py`.
>
> 1. Build a per-game *aggregate* feature vector: median income at 4/6/8 min, third-base timing (or 9999), key-building timings (Twilight/Robo/Stargate/Spire), army peak before 8min, supply-blocked seconds, total APM, matchup one-hot, **win label NOT included in clustering**.
>
> 2. Standardize features with `StandardScaler`. Run `KMeans(n_clusters=k)` for k in 3..7, pick best by silhouette score. Optionally compare against `DBSCAN(eps=0.6)`.
>
> 3. For each cluster: compute win rate, average key timings, most common matchup, most common opening, top 3 most-distinctive features (largest standardized centroid components). Auto-name: e.g. "Fast 3rd / High Income (W:75%)" or "Late 3rd / Low Income (W:40%)".
>
> 4. UI: new "Insights" tab. Show cluster cards with name, count, W%, distinctive features, and a "Show Games" button that filters the games list to that cluster. Surface 3 plain-language insights at the top: e.g. *"Your 3rd base in wins: 4:08 median. In losses: 5:14. Faster third correlates with +18% win rate."* These come from comparing cluster centroids of high-WR vs low-WR clusters.
>
> 5. Persist `cluster_id` and `cluster_name` to each game in the DB.
>
> Test: synthetic DB with two distinct play-styles should cluster cleanly.

---

## Phase 4 — Map Renderer + Mini-Map Replay Playback (2 weeks)

**Why fourth:** delays user-visible work but unblocks the heatmap. Builds the canvas everyone else uses.

**Scope:**
- Bundle map metadata: name → playable bounds (x_min, x_max, y_min, y_max), starting locations, expansion locations. The Liquipedia map pages have these or you can extract from the replay's `map_data` blob (`replay.map.archive`).
- Tkinter Canvas with: pan, zoom, timeline scrubber.
- Render building icons (buy a pixel-art SC2 icon pack or generate placeholder PNGs from the game's casc).
- Render unit positions per PlayerStatsEvent snapshot (army centroid only is fine for v1).
- Battle markers where army-value drops > 500 in 10s.

**Prompt — Mini-Map Replay Playback**

> Build an interactive map playback viewer in `ui/map_viewer.py`. Use Tkinter Canvas (already a dependency).
>
> 1. Map metadata: create `data/map_bounds.json` with {`map_name`: {`x_min`, `x_max`, `y_min`, `y_max`, `starting_locations`: [[x,y]]}}. Pre-populate 10 current ladder maps. The bounds can be extracted from `sc2reader`'s `replay.map.archive` MPQ data (the map info file) — write a one-time extractor script `scripts/extract_map_bounds.py` that takes a replay and prints the bounds for inclusion.
>
> 2. `MapViewerWindow(parent, game_data, player_name)` — opens from existing GameVisualizerWindow via a new "Map Playback" button.
>    - Top: zoom buttons, play/pause, speed dropdown (1x/2x/4x), timeline slider (range 0..game_length_sec).
>    - Center: 800x800 Canvas with map bounds normalized to fill the canvas.
>    - Render: starting locations as dim circles; buildings as colored squares (blue=me, red=opponent) appearing at their `time` and persisting (until destroyed — for v1 ignore destroyed).
>    - Army centroid: a colored dot at each player's army center, sized by army value, animated along the timeline using PlayerStatsEvent snapshots interpolated linearly.
>    - Battle markers: a yellow X at each location where army-value-diff swings > 500 in a 10-second window.
>    - Hover building → tooltip with name + time + result.
>
> 3. Reuse the data shape from `extract_events` — already has x,y,time,name,type per event.
>
> 4. Performance: cache the static building layer; only redraw the moving layer per frame. Animation via `Canvas.after(33, ...)` (~30 FPS).
>
> Test against 3 different maps. Make sure pan/zoom feels responsive.

---

## Phase 5 — Spatial Heatmaps + Death Zones (1 week)

**Why last:** trivial once the map renderer exists. Mostly aggregation + a heatmap overlay.

**Scope:**
- Aggregate event locations across *all* games per map.
- Render kernel-density estimate (KDE) heatmaps overlaid on the map canvas.
- Three views: my building hot-spots, opponent proxy attempts, battle locations (engagement deaths).
- "Death zones": cells where the average army-value-loss outcome is bad for me.

**Prompt — Spatial Heatmaps**

> Implement Spatial Heatmaps in `analytics/spatial.py` and a new "Map Intel" tab in the UI. Reuses `ui/map_viewer.py`'s canvas renderer.
>
> 1. `SpatialAggregator(db)` methods:
>    - `building_heatmap(map_name, owner='me')` — collect all building (x,y) from games on this map for the chosen owner, return a 100x100 density grid using a Gaussian KDE (`scipy.stats.gaussian_kde` — add scipy to requirements).
>    - `proxy_heatmap(map_name)` — only buildings flagged proxy by the existing `_is_proxy` logic, owner=opponent.
>    - `battle_heatmap(map_name)` — engagement locations (army-centroid-at-battle-marker times, stored during the macro-score extraction in Phase 2).
>    - `death_zone_grid(map_name, my_race)` — 20x20 grid; for each cell compute mean(my_army_lost - opp_army_lost) for engagements in that cell; redder = worse outcome for me.
>
> 2. UI: "Map Intel" tab. Map dropdown lists all maps with >=3 games. Toggle buttons for the 4 overlay types. Render the heatmap as a semi-transparent imshow on top of the map canvas. Use matplotlib's `viridis` for densities, `RdYlGn_r` for death zones.
>
> 3. Add a sidebar widget on each opponent profile (from Phase 1): "Proxy patterns vs you" — showing this opponent's proxy locations across all your games against them.
>
> Test: at least 10 games on the same map should produce a recognizable density. Verify KDE doesn't crash on a single-point dataset (fall back to a 5x5 box around that point).

---

## Suggested calendar

If you can ship one phase per ~1.5 weeks, you're done in roughly 10 weeks. If you want a public release sooner, ship after Phase 1 (DNA Profiler) as v2.0, then again after Phase 2 (Macro Score) as v2.1 — both are independently impressive.

| Phase | Feature | Effort | Cumulative |
|---|---|---|---|
| 0 | Foundation refactor | 1–2 days | 2d |
| 1 | Opponent DNA | 3–5 days | 1w |
| 2 | Macro Score | 1–2 weeks | 3w |
| 3 | Win Prob + Clustering | 2 weeks | 5w |
| 4 | Map Playback | 2 weeks | 7w |
| 5 | Spatial Heatmaps | 1 week | 8w |

---

## Cross-cutting things worth doing alongside

- **Tests.** Add `pytest` and write tests against a small set of bundled `.SC2Replay` fixtures. Once the code is split into modules this becomes possible.
- **Versioned DB migrations.** Phase 0 sets this up; every later phase adds 1–2 fields. Don't break older users.
- **Optional dependencies.** Wrap the new heavy deps (sklearn, scipy) in try/except with a clear "install scikit-learn for Win Probability" message — same pattern as your matplotlib block at lines 44–54.
- **Telemetry off by default**, but add a hook so you can later see which features users actually open. A single counter in `config.json` per feature is enough.
