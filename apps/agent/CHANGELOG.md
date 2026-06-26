# Changelog

All notable changes to `@sc2tools/agent` go here. Newest first.

## 0.13.2

### Fixed — PvZ 2 Stargate Void Ray no longer mislabeled "Stargate into Robo" on a late support Robo
- **What.** The bundled replay-engine classifier
  (`core/strategy_detector_pvz.py`, frozen into the agent build) tagged
  a real 2-Stargate Void Ray opener (Stargate-first, 2 bases, 4+ Void
  Rays by 10:00) as `PvZ - Stargate into Robo` whenever it added a
  support Robotics Facility (Observer / Immortal) before 10:00. The
  Void Ray rule rejected ANY Robo before 10:00, so the build failed it
  and the next rule -- Stargate into Robo, which fires on "Robo present
  + one Stargate unit" -- grabbed it instead.
- **Effect.** The Void Ray rule's Robo guard now rejects only an EARLY
  Robo (before 6:00). A later support Robo behind a 4+ Void Ray
  commitment keeps the `PvZ - 2 Stargate Void Ray` label; genuine
  Stargate-into-Robo builds (an early Robo, or fewer than 4 Void Rays)
  are unchanged, as are the Phoenix rules (they keep the full 10:00
  window). Fixed in both the canonical detector and the
  `detectors/user.py` mirror, with a regression test covering both
  entry points. The agent computes this label locally before upload,
  so the corrected label ships only with this build and installed
  agents auto-update; previously-uploaded games keep their old label
  until the updated agent re-parses them.

## 0.13.1

### Fixed — PvZ Glaives-first Stargate openers no longer mislabeled "Stargate into Robo"
- **What.** The bundled replay-engine classifier
  (`core/strategy_detector_pvz.py`, frozen into the agent build) tagged
  a Stargate-first PvZ build that researched Resonating Glaives as the
  FIRST Twilight upgrade and only later added a Robotics Facility
  (Observer / Immortal support behind a Glaive Adept timing) as
  `PvZ - Stargate into Robo`. That rule fired on "Robo present + one
  Stargate unit" and ran BEFORE `PvZ - Stargate into Glaives`, so a
  build whose Robo came after the Twilight got pulled onto the Robo
  label even though Glaives was the defining tech choice.
- **Effect.** The `Stargate into Robo` rule now carries the same
  `not glaive_first_off_twilight` guard its sibling Stargate rules
  (2/3 SG Phoenix, 2 SG Void Ray) already had, so Glaives-first builds
  fall through to `PvZ - Stargate into Glaives` while genuine
  Stargate-into-Robo builds (no Glaives-first signal) are unchanged.
  Fixed in both the canonical detector and the `detectors/user.py`
  mirror, with a regression test covering both entry points. The agent
  computes this label locally before upload, so the corrected label
  ships only once this build is released and installed agents
  auto-update; previously-uploaded games keep their old label until the
  updated agent re-parses them.

## 0.13.0

### Fixed — dashboard "Synced" stat now shows the real total
- **What.** The stat card counted uploads with a session-local
  `+= 1` counter: it reset to 0 on every launch and double-counted
  re-uploads after a mid-session Re-sync. It now reads the dated
  entries in `state.uploaded` via `state.count_synced()` (sentinel
  markers — `filtered` / `rejected` / `skipped[:reason]` — are
  excluded), seeded at boot and re-queried on every repaint.
- **Effect.** The number survives restarts, matches what actually
  reached the cloud, and drops back honestly when a Re-sync wipes the
  cursor.

### Fixed — import job cards no longer heartbeat forever
- **What.** `total` is a point-in-time estimate from
  `count_pending()`; settle-failures, backpressure drops, and a
  wedged upload worker never invoke a counted callback, so
  `processed >= total` could NEVER become true and the reporter
  posted `import:progress` every 10 s until the agent was restarted —
  the web app refreshed continuously even with nothing left to sync
  (observed 2026-06-10/11: job `total=12661` outlived its session).
- **Effect.** After 10 minutes with zero counter movement the
  reporter re-checks the disk and closes the job card — as
  `import_complete` when nothing is pending, otherwise as
  `import_stalled_card_closed` (logged with a WARNING). Background
  sync itself is unaffected; only the narration stops.

### Added — full ZvP and TvP build coverage (engine)
- **What.** The bundled engine's per-matchup trees now cover ZvP with
  10 builds (12 Pool Rush, Ling Bane Bust, Roach/Ravager All-in,
  Nydus, Hydra Timing, Lurker Contain, Ling Bane Muta, Muta Harass,
  Speedling Flood, Hatch First Macro) and TvP with 11 (proxy rax /
  Marauder, Cyclone, 1-1-1 Banshee, 3 Rax, BC Rush, Tank/Thor Mech,
  Widow Mine Drop, 2-1-1 Reaper Expand, 2 Base Tank Push, Fast 3 CC
  Bio) — parity with the other four matchups. Thresholds are cloned
  from the proven sibling-matchup rules.
- **What, part 2.** The legacy `detectors/` stack (bulk-import CLI,
  macro/apm CLIs, local SPA) no longer returns
  `Unclassified - Zerg/Terran`: it delegates to the same shared
  classifier the agent and opponent detector use, so the last
  "Stub - TODO Stage 8" placeholders are gone.
- **Effect.** Zerg and Terran players get precise matchup labels in
  every matchup from every parse path. The Builds page offers a
  one-click "Reclassify my games" for stored games still carrying the
  old sentinel. `scripts/benchmark_builds_cli.py` (new) measures
  specific-label share per matchup against a real replay folder.

## 0.12.0

### Added — bulk imports are finally visible (and web-triggerable)
- **What.** The agent now listens to the cloud's `import:*` socket
  events (`scan`, `start`, `cancel`, `pick_folder`) and reports live
  progress to `/v1/import/progress` while a job runs. The cloud has
  emitted these events since the SaaS cutover; until now the agent
  never subscribed, so the web app's "Start full import" created a job
  that sat **running forever** with no progress.
- **Effect.** Starting an import from the dashboard or Settings now
  drives the agent for real: the web shows "980 / 4,200 replays ·
  ~6 min left" with a live bar, per-file failure reasons, and a Cancel
  button. (`ImportController` in `import_controller.py` — a thin
  reporting layer over the existing watcher/uploader, not a second
  parse pipeline.)

### Added — the first-run history backfill announces itself
- **What.** When the startup sweep finds 25+ un-uploaded replays (first
  run, or a long offline stretch), the agent registers the backlog as a
  visible job via `POST /v1/import/agent-start` before working through
  it.
- **Effect.** A new user who installs + pairs sees their entire ladder
  history streaming into the dashboard with a progress card — the work
  always happened; now it's visible.

### Added — per-file skip reasons
- **What.** `parse_replay_for_cloud_ex` distinguishes WHY a replay was
  unusable (`ai_game`, `player_unresolved`, `no_result`,
  `parse_failed`), the watcher persists the code
  (`state.uploaded = "skipped:<reason>"`, prefix-compatible with old
  entries), and import progress carries a breakdown + capped samples.
- **Effect.** The web's import card can say "3 files: couldn't tell
  which player is you — set your BattleTag in Settings" instead of a
  bare failure count. vs-AI replays count as skipped, not failed.

## 0.11.0

### Changed — parsing now resolves entirely from `apps/replay-engine`
- **What.** The replay-parsing engine moved from the legacy repo-root
  `SC2Replay-Analyzer/` folder to `apps/replay-engine/`, and the agent's
  parse closure (`core.sc2_replay_parser`, `core.pulse_resolver`,
  `core.event_extractor`, the build-definition and strategy-detector
  modules) is now sourced from that single engine. The retired
  `reveal-sc2-opponent-main/` local product the agent used to fall back to
  has been deleted; the agent no longer probes it.
- **Effect.** No change to which games parse or upload. The bundled `.exe`
  ships `apps/replay-engine/` (see `packaging/sc2tools_agent.spec`).

### Added — your own build now classifies in every matchup
- **What.** The user-side and opponent-side build detectors now share one
  perspective-agnostic race classifier built from the same
  `build_definitions` catalog. Previously only Protoss user builds were
  classified; a user who played Terran or Zerg got `Unclassified - <race>`.
- **Effect.** Your own Terran/Zerg builds now get real labels (e.g. a fast
  three-Command-Center Terran uploads as `Terran - Fast 3 CC` instead of
  `Unclassified - Terran`), matching how the opponent's build is labelled.
  Protoss keeps its richer matchup-specific labels. Re-ingest (Resync) to
  re-label previously analysed games.

### Added — detailed per-matchup build orders for Terran & Zerg
- **What.** New matchup-specific detectors (`core.strategy_detector_matchups`)
  add ~10 recognizable pro build orders each for TvT, TvZ, ZvT and ZvZ
  (plus the proxy-reaper all-in for TvP and a ling/bane/muta for ZvP),
  mirroring the detailed Protoss matchup trees — e.g. `TvZ - 3 CC Bio`,
  `TvT - Tank/Thor Mech`, `ZvT - 3 Hatch Ling Bane Muta`,
  `ZvZ - Mutalisk vs Mutalisk`, and a `Proxy 4 Rax Reaper` shared by all
  three Terran matchups. They run for BOTH the player's and the opponent's
  events, so a build classifies the same way whoever executed it.
- **Effect.** Both your own and your opponent's Terran/Zerg games now carry
  precise matchup labels when a known build is detected; anything else falls
  back to the generic race label (no existing labels changed). All 45 builds
  also appear on the Build & Strategy Definitions page, and custom builds can
  be authored for these matchups exactly like Protoss.

### Fixed — build-log unit names use the canonical engine extractor
- **What.** The build log is now produced by the engine's
  `event_extractor`, the same one the cloud API uses, instead of the older
  divergent copy the agent carried.
- **Effect.** Fixes the name-cleaning bug that corrupted
  `SupplyDepotLowered` into `SupplyDepoted` and `Zergling` into `ling`,
  drops the transient Reaper `KD8Charge` effect from build logs, and
  includes Overlords — so the agent's build log now matches the cloud.

## 0.10.1

### Fixed — opponent build classification under-counted bases (pre-placed main)
- **Symptom.** Opponent builds were mislabelled because the pre-placed
  main town hall (Command Center / Nexus / Hatchery) was not being
  counted. The reported case: a Terran fast 3 CC was tagged
  `Terran - Standard Bio Tank`.
- **Root cause.** Real replays emit only a `born` event (no `init`)
  for the game-start town hall, but the classifier counted bases from
  construction-START (`init`/`morph`) events only, so the main was
  invisible. A true fast-3-CC (main + 2 expansions = 2 init events) read
  as 2 and failed the `>= 3` test; the same gap skewed every
  "second base" / "Nth base" heuristic across all three races (e.g. a
  Zerg Hatch-First opening read as Pool-First, Protoss "Standard Expand"
  / "Standard Macro" thresholds shifted by one base). Unit-test fixtures
  modelled the main as a t=0 `init`, so the bug never surfaced in CI.
- **Fix.** Base counting now goes through the shared
  `base_count_at` / `nth_base_start` / `start_times_excluding_main`
  helpers, which count the pre-placed main as base #1 and work for both
  real-replay (`born`) and fixture (`init`) event shapes. Applied across
  the Terran, Protoss, and Zerg opponent-classification branches.
- **Effect.** Re-ingested games (via a Resync) classify the opponent's
  build correctly; previously analysed games are unaffected until
  re-ingested.

## 0.10.0

### Added — authoritative ladder/custom signal (`isLadderGame`)
- **Emit `isLadderGame`** on every uploaded game, read from the replay's
  matchmaking category (sc2reader `replay.category` == "Ladder", with an
  `amm`/`ranked`/`competitive` boolean fallback). `true` = ranked ladder
  game, `false` = custom/unranked, omitted when the replay doesn't
  expose it.
- **Why.** The cloud's ladder / Custom map filter has been classifying
  games by matching the map name against the ladder pool — a proxy that
  mislabels a custom game played on a ladder map (or a ladder game on a
  since-retired map). The cloud now prefers this authoritative flag when
  present and falls back to the map-name proxy otherwise, so re-ingested
  games (via a Resync) classify with 100% accuracy.
- **Backwards-compatible.** Optional on the wire and in the cloud
  schema; games uploaded by older agents simply keep using the proxy.

## 0.9.1

### Fixed — live opponent Pulse/MMR misses at game start (region hint + clan-tag strip)
- **Symptom.** During a real game the overlay frequently showed no
  opponent MMR / Pulse profile, even though the on-demand diagnostics
  "Retry" resolved the same opponent instantly. Root cause: the two
  paths resolve by different keys. The diagnostics/post-game paths key
  off the replay's **toon handle** (`region-realm-bnid`) and confirm the
  exact account, while the live game-start path only has the **display
  name** (Blizzard's local `/game` API never exposes the opponent's toon
  handle or MMR), so it ran a fuzzy, region-blind name search that
  missed on cross-region name collisions and clan-tagged names.
- **Region hint.** `LiveBridge` now forwards the streamer's own region
  (derived from their toon handle) to `PulseClient.resolve`. In 1v1 the
  opponent shares the streamer's server, so this disambiguates
  same-name accounts across regions and lifts the candidate score. The
  hint is omitted (not guessed) until the streamer's handle is known.
- **`NA` region alias.** `pulse_lookup` previously only knew SC2Pulse's
  `US` label for region code 1, so a hint derived from a toon handle
  (`NA`) wouldn't have matched. Added `NA → 1` so the hint actually
  applies. `SEA` (byte 6) intentionally stays unmapped and degrades to
  "no region constraint".
- **Clan-tag strip.** Live name lookups now strip a leading clan tag
  (`[oM]Cure` → `Cure`) before hitting `/character/search`, mirroring
  the post-game pipeline — SC2Pulse indexes the bare account name, so
  the tagged term was missing.
- **Hard limit unchanged.** Pure barcodes (`IIIIIIII`) still cannot be
  resolved by name at game start — only the post-game toon-handle path
  can identify them — because the local SC2 API exposes no toon handle
  mid-game.
- **Tests.** 4 new cases (`test_live_pulse_lookup.py`,
  `test_live_bridge.py`): clan-tag search-term strip, `NA` alias wins
  the region tiebreak, region hint propagates from the streamer's
  handle, and region stays `None` without a handle. Live + bridge
  suites: 36/36 passing.

## 0.9.0

### Added — per-replay `playerCount` for the cloud's 1v1 / team filter
- **Emit `playerCount`** on every uploaded game, derived from the
  parsed replay's player list (`len(ctx.all_players)` — humans + AI,
  observers excluded; AI games are already dropped upstream). It is 2
  for a 1v1 and 4/6/8 for 2v2/3v3/4v4.
- **Why.** The cloud's new global FilterBar control (Players · 1v1 /
  Team) `$match`es on this field across every analyzer tab (Opponents,
  Strategies, Trends, Maps, Builds). Without it the team/1v1 buckets
  have nothing to filter on.
- **Backwards-compatible.** The field is optional on the wire and in
  the cloud schema; games uploaded by older agents carry no count and
  the cloud records them as size-unknown.
- **Tests**: `to_payload` emits/omits `playerCount`; the
  `parse_replay_for_cloud` end-to-end case asserts `playerCount == 2`
  for a two-player replay.

## 0.8.8

### Added — PvP Glaive Adept classification (`Robo into Glaives` + `Adept Glaives`)
- **User-reported gap.** PvP had no Glaive Adept label at all, so two
  common builds were mis-tagged by the Blink-keyed rules: a Robo-first
  Glaive build (Robo → Twilight → Glaives) fell into
  `PvP - Rail's Blink Stalker (Robo 1st)` (which checks no upgrade at
  all), and a Twilight-first Glaive build that later picked up Blink
  fell into `PvP - Blink Stalker Style` (which keys on Blink merely
  existing).
- **Added `PvP - Robo into Glaives`**: Robotics Facility built BEFORE
  the Twilight Council AND Glaives is the FIRST upgrade off that
  Twilight (before Blink AND Charge). Sits above `Rail's Blink Stalker
  (Robo 1st)` so the Glaives-first signal wins.
- **Added `PvP - Adept Glaives`**: Twilight Council is the FIRST tech
  building (before any Robotics Facility AND any Stargate, pure
  ordering) AND Glaives is the first upgrade off it. Sits above
  `Blink Stalker Style`.
- **Order-based, no Gateway window** — same principle as the PvZ / PvT
  Glaive rules. The generic `PvP - 1 Gate Expand` / `PvP - 2 Gate
  Expand` opener labels now fall through on a Glaives-first transition
  so these labels are reachable for builds that opened with a standard
  expand.
- **Mirror** `SC2Replay-Analyzer/detectors/user.py` updated in lockstep
  with the canonical `core/strategy_detector_pvp.py`.
- **Catalog**: two new entries in both `data/build_definitions.json`
  and `apps/web/lib/build-definitions/pvp.ts` (which powers the
  `/definitions` page); `Rail's Blink Stalker (Robo 1st)` description
  updated to point at the new label.
- **Tests**: 8 new cases in `test_strategy_detector_pvp_glaives.py`
  (both labels classify, Glaives-first wins over a later Blink,
  Blink-first negatives, Robo-vs-Twilight-first split, catalog
  presence). Full self-contained strategy-detector suite: 135/135
  passing.

## 0.8.7

### Fixed — PvZ Stargate into Glaives is order-based; drop the Gateway-count cap
- **User-reported misclassification.** A `Stargate → Twilight →
  Glaives-first → Blink-later` build (a Phoenix/Oracle into Glaive
  Adept timing that warps a heavy Gateway count) was being labelled
  `PvZ - Standard Blink Macro` instead of `PvZ - Stargate into
  Glaives`. The user upgraded Glaives FIRST off the Twilight — Blink
  only came later — so the build is unambiguously a Glaives build.
- **Root cause**: the `PvZ - Stargate into Glaives` rule required
  `4 <= gate_count_6min <= 8`. A real Glaive Adept timing routinely
  warps 9+ Gateways (mass Adepts ARE the build), so it failed the
  upper bound, skipped the Glaives label, and fell through to the
  `Standard Blink Macro` rule once Blink was researched second and a
  3rd Nexus was taken. The sibling `PvT - Stargate into Glaives` rule
  has never had a Gateway-count window — it classifies purely on
  ordering, which is correct.
- **Fix**: removed the `4 <= gate_count_6min <= 8` window from
  `PvZ - Stargate into Glaives` in
  `reveal-sc2-opponent-main/core/strategy_detector_pvz.py`.
  Classification is now purely order-based: Stargate built before
  Twilight + Glaives is the FIRST upgrade off the Twilight (before
  Blink AND Charge) ⇒ Stargate into Glaives, regardless of Gateway
  count or a later Blink.
- **Mirror brought back in sync**: the
  `SC2Replay-Analyzer/detectors/user.py` copy was further out of date
  — it still used a loose `has_upgrade_substr("Glaive", 600)`
  *existence* check (any Glaives, even AFTER Blink) plus an even
  tighter `4 <= gate_count_6min <= 6` cap. It now uses the same
  `glaive_first_off_twilight` ordering signal as the canonical
  detector with no Gateway window.
- **Catalog**: the `PvZ - Stargate into Glaives` description was
  refreshed in both `data/build_definitions.json` (canonical Python
  catalog) AND `apps/web/lib/build-definitions/pvz.ts` (TS catalog
  behind the `/definitions` page) to drop the "4-8 Gateways by 6:00"
  qualifier and state the order-based, no-Gateway-window rule.
- **Tests**: 2 new regression cases in
  `test_strategy_detector_pvz_adept_glaives.py`:
  - `test_stargate_into_glaives_classifies_with_heavy_gateway_count`
    pins the reported shape (9 Gateways, 3 bases, Glaives-then-Blink →
    Stargate into Glaives).
  - `test_stargate_into_glaives_classifies_with_few_gateways`
    confirms a low Gateway count still classifies on ordering.
  Existing Blink-first negative tests still pass (Blink-first builds
  must NOT tag as Glaives). Full self-contained strategy-detector
  suite: 127/127 passing.

## 0.8.6

### Changed — Cosmetic version bump, no behavioural change
Identical detector behaviour to 0.8.5; bumped solely to give the
renamed `PvZ - Stargate into Robo` label (formerly drafted as
`PvZ - Phoenix into Robo` in the 0.8.5 PR review) its own release
tag. The rename happened pre-release based on user feedback that
"Stargate into Robo" better describes the tech-transition intent
than "Phoenix into Robo" -- the rule's unit-acceptance set is
Phoenix / Oracle / Void Ray, so "Phoenix" was a misnomer.

The PvT - Phoenix into Robo label is unchanged -- the PvT rule has
always required a real Phoenix specifically (no Oracle / VR
acceptance) so the "Phoenix" in its name is accurate. Only the PvZ
counterpart is renamed.

Full strategy-detector test suite: 142/142 still passing (no
behaviour change).

## 0.8.5

### Fixed — PvZ Stargate-into-Robo no longer mis-fires as 2 Stargate Phoenix + new PvZ - Stargate into Robo + new PvZ - Stargate Opener catch-all
- **User-reported regression (Ruby Rock LE 2026-04-01 10:39:06).** A
  Stargate-FIRST opener that produced Phoenix and added a Robotics
  Facility for Immortal / Observer / Disruptor support was labelled
  `PvZ - 2 Stargate Phoenix`. The user opened "Stargate into Robo" --
  a classic transition style that the PvZ tree had no dedicated label
  for, so the count-by-10:00 signature (`>=2 Stargates, >=2 Nexus,
  >=4 Phoenix`) of 2 SG Phoenix won by default.
- **Audit finding**: the PvT classifier already has the parallel
  rules (`PvT - Phoenix into Robo`, `PvT - Stargate Opener`,
  `PvT - Stargate into Charge / Glaives / Blink`) -- they were just
  never mirrored into PvZ. The 0.8.4 Glaives-disqualifier work
  introduced the pattern of "headline rules disqualify themselves
  when a tech-switch signal is present"; the Robo case is the
  natural symmetric companion.
- **Fix**:
  1. **Added `not has_building("RoboticsFacility", 600)`** to the
     three pure-Phoenix / pure-VR Stargate-rush rules:
     `PvZ - 2 Stargate Phoenix`, `PvZ - 3 Stargate Phoenix`,
     `PvZ - 2 Stargate Void Ray`. A Stargate opener that adds a Robo
     is committing to a tech-switch and shouldn't claim the "pure
     Phoenix / pure VR" label.
  2. **Added `PvZ - Stargate into Robo`** -- PvZ counterpart of
     PvT's `Phoenix into Robo`, renamed for the PvZ-side rule to use
     the generic "Stargate into" phrasing because the rule accepts
     any Stargate unit, not just Phoenix. Fires for
     `stargate_first_tech AND has_building("RoboticsFacility", 600)
     AND >=1 real Phoenix / Oracle / Void Ray by 10:00`. Sits after
     AlphaStar Style (which has its own more specific Oracle + Forge
     + 3-base signature) so AlphaStar wins on hybrid builds that fit
     its shape.
  3. **Added `PvZ - Stargate Opener`** catch-all -- mirror of PvT's.
     Fires for any `stargate_first_tech` build that didn't match a
     more specific Stargate-prefixed rule. Examples that land here:
     a Stargate that got harassed off before producing a real unit,
     a Stargate-into-Templar build without 2 Archons by 9:00, or any
     Stargate opener with an unusual midgame composition the
     analyzer doesn't have a named bucket for. Previously these all
     fell through to `PvZ - Macro Transition (Unclassified)`.
- **Catalog**: two new entries shipped in both
  `data/build_definitions.json` (canonical Python catalog) AND
  `apps/web/lib/build-definitions/pvz.ts` (TS catalog that powers
  the `/definitions` page). The descriptions for 2/3 SG Phoenix and
  2 SG VR were rewritten to call out the new Robo-disqualifier.
- **Mirror** in `SC2Replay-Analyzer/detectors/user.py` in sync --
  same Robo guard on the three pure-Phoenix / pure-VR rules, same
  new Stargate-into-Robo rule, same Stargate-Opener catch-all.
- **Tests**: 5 new regression cases in
  `test_strategy_detector_opener_guards.py`:
  - `test_stargate_first_into_robo_classifies_as_stargate_into_robo`
    pins the reported replay shape (now resolves to Stargate into Robo).
  - `test_stargate_into_robo_accepts_oracle_or_voidray_as_stargate_unit`
    confirms the rule fires on Oracle-into-Robo and VR-into-Robo too.
  - `test_pure_2_stargate_phoenix_without_robo_still_classifies`
    positive control -- the new Robo guard doesn't over-fire on pure
    2 SG Phoenix.
  - `test_stargate_opener_catch_all_when_no_specific_rule_matches`
    confirms the new catch-all label.
  - `test_stargate_opener_present_in_catalog`
    catalog-presence check for both new entries. Full strategy-detector
  test suite: 142/142 passing.

## 0.8.4

### Fixed — PvZ 2/3 SG Phoenix + 2 SG Void Ray now key on pure tech-ordering (no time threshold) AND disqualify on Glaives-first opener
Two refinements to the 0.8.3 Stargate-opener guard, shipped together
in the same release because they fix the same underlying anti-pattern
(`headline count by 10:00` running before more-specific tech-ordering
rules in the decision tree).

#### (1) Glaives-disqualifier on the Stargate-rush rules
- **User-reported regression (Taito Citadel LE 2026-05-25 10:05:36).**
  A Stargate-FIRST opener that added a Twilight Council after the
  Stargate and researched Glaives FIRST off the Twilight Council was
  labelled `PvZ - 2 Stargate Phoenix`. The replay's actual shape was a
  Stargate-into-Glaives Adept timing: heavy Adept production from 6:18
  onwards, Ground Weapons +1 at 6:23, 2 Phoenix visible off a Stargate
  at 6:43-6:44, Glaives research kicked off at 6:46.
- **Root cause**: the 0.8.3 `stargate_first_tech` guard correctly
  identified the build as a Stargate opener, but the 2 SG Phoenix
  headline rule (`>=2 Stargates, >=2 Nexus, >=4 Phoenix by 10:00`)
  ran BEFORE `PvZ - Stargate into Glaives` in the decision tree, with
  no signal that distinguished "pure 2 SG Phoenix" from "Stargate
  opener that committed to Glaives and runs Phoenix as harass /
  scouting support". The Glaives upgrade itself is the discriminator.
- **Fix**: hoisted `glaive_first_off_twilight` to the top of
  `detect_pvz` (alongside `stargate_first_tech`) and added
  `AND not glaive_first_off_twilight` to all three Phoenix-/VR-count
  Stargate-rush rules: `PvZ - 2 Stargate Phoenix`,
  `PvZ - 3 Stargate Phoenix`, and `PvZ - 2 Stargate Void Ray`. A
  Stargate-FIRST opener with Glaives as the first Twilight upgrade
  now falls through to `PvZ - Stargate into Glaives` regardless of
  late Phoenix / Void Ray count. The Carrier / Tempest / AlphaStar
  rules are NOT guarded -- their Fleet Beacon + capital-ship timing
  window is too tight for a Glaives-into-capital-ship transition to
  fit inside 10:00.

#### (2) Pure tech-ordering on EVERY opener guard -- no time thresholds
- **User feedback**: an opener is defined by what tech building was
  committed FIRST, period -- not by an arbitrary time threshold. If
  Twilight / Robo / DarkShrine went down before Stargate, it's a
  transition INTO Stargate; conversely a Stargate with nothing else
  before it IS a Stargate opener even at 7:00 (just a slow one). A
  slow opener is still an opener. Applied symmetrically to every
  opener rule in `detect_pvz`:
  - `stargate_first_tech` was `sg_time < 360 AND <ordering>`; now
    `sg_time < 9999 AND <ordering>`.
  - `twilight_first_tech` was `twilight_time < 480 AND <ordering>`;
    now `twilight_time < 9999 AND <ordering>`.
  - DT Opener rule was `dark_shrine_time < 480 AND <ordering> AND
    >=1 DT by 9:00`; now `dark_shrine_time < 9999 AND <ordering> AND
    >=1 DT by 9:00`.
  - Robo Opener rule was `has_building("RoboticsFacility", 420) AND
    <ordering>`; now `robo_time < 9999 AND <ordering>` (also added
    the previously-missing `robo_time < dark_shrine_time` check for
    symmetry).
  - Stargate-into-Glaives rule was `sg_time < 420 AND <ordering> AND
    Glaives-first AND 4-8 gates by 6:00`; now `sg_time < 9999 AND
    <ordering> AND Glaives-first AND 4-8 gates by 6:00`.
- **Symptoms under the old guards**: slow-but-pure openers fell
  through to `PvZ - Macro Transition (Unclassified)` because the time
  thresholds refused to call them openers. Tech-ordering already
  excludes transitions; the time threshold was double-counting and
  only ever excluding the slow-pure case. Downstream constraints
  (gate count, unit count, upgrade research, base count) already
  filter inappropriate matches.
- **Catalog prose**: all six Stargate-rush rules (Carrier Rush,
  Tempest Rush, 2 SG Void Ray, 3 SG Phoenix, 2 SG Phoenix, AlphaStar
  Style) drop the "(built before 6:00 ...)" qualifier. The DT
  Opener, Robo Opener, Stargate-into-Glaives, Adept Glaives (Robo),
  and Adept Glaives (No Robo) descriptions drop their "before 8:00" /
  "before 7:00" / "by 9:00" qualifiers (the Adept Glaives rules
  actually use `gate_count_6min`, so the "by 9:00" Gateway-count
  wording was always stale) and call out the pure-ordering principle.
  Catalog files touched: `data/build_definitions.json` (canonical
  Python catalog) AND `apps/web/lib/build-definitions/pvz.ts` (the
  TS catalog that powers the `/definitions` page in the web app).

#### Shared infrastructure
- Mirror in `SC2Replay-Analyzer/detectors/user.py` in sync.
- Catalog prose (`data/build_definitions.json`,
  `apps/web/lib/build-definitions/pvz.ts`) updated for all six
  affected rules (Carrier Rush, Tempest Rush, 2 SG Void Ray, 3 SG
  Phoenix, 2 SG Phoenix, AlphaStar Style).
- Tests: 7 new regression cases in
  `test_strategy_detector_opener_guards.py`:
  - `test_stargate_first_into_glaives_does_not_mis_fire_as_2_stargate_phoenix`
    pins the reported replay shape (now resolves to Stargate into
    Glaives).
  - `test_pure_2_stargate_phoenix_without_glaives_still_classifies`
    positive control -- pure Phoenix (no Twilight, no Glaives) still
    matches.
  - `test_slow_2_stargate_phoenix_with_no_earlier_tech_still_classifies`
    locks in the pure-ordering refinement on Stargate -- a slow
    Stargate opener (7:00 first SG) with no other tech still
    classifies as 2 SG Phoenix.
  - `test_slow_dt_opener_with_no_earlier_tech_still_classifies`
    vice-versa: a slow Dark Shrine (7:30) with no earlier Stargate /
    Robo still classifies as DT Opener.
  - `test_slow_robo_opener_with_no_earlier_tech_still_classifies`
    vice-versa: a slow Robotics Facility (7:30) with no earlier
    Stargate / Twilight / Dark Shrine still classifies as Robo
    Opener.
  - `test_slow_twilight_first_glaives_still_classifies`
    vice-versa: a slow Twilight Council (8:10) with no earlier
    Stargate / Robo / DT plus Glaives first plus 4-8 Gateways by
    6:00 still classifies as Adept Glaives (No Robo).
  - `test_stargate_first_into_blink_still_classifies_as_blink_macro`
    pins the Glaives discriminator -- Blink-first Stargate opener
    still matches 2 SG Phoenix (the guard is keyed on Glaives, not
    Twilight-existence).
  Full strategy-detector test suite: 137/137 passing.

## 0.8.3

### Fixed — PvZ Stargate-rush labels require Stargate to be the FIRST tech building + new PvZ - DT Opener path + Zerg Nydus check runs before Muta Rush
- **Three user-reported mis-classifications in the same session, all
  rooted in count-by-10:00 rules with no opener-ordering check.**
- **User-visible symptom**:
  - A PvZ DT build that transitioned into Carriers/Mothership was
    labelled `PvZ - Carrier Rush`.
  - A PvZ Glaive Adept opener (Twilight first) that added 2 Stargates
    around 7:00 to counter Lurkers was labelled
    `PvZ - 2 Stargate Phoenix`.
  - A Zerg opponent Nydus build was labelled
    `Zerg - 2 Base Muta Rush` (the opponent had also added a Spire
    for late air follow-up).
- **Fix #1 — PvZ Stargate-opener guard.** Every Stargate-rush rule
  in `core/strategy_detector_pvz.py` now requires
  `sg_time < 360 AND sg_time < twilight_time AND sg_time <
  dark_shrine_time AND sg_time < robo_time` so the label means what
  it says: Stargate was the first tech building. Affects
  `PvZ - Carrier Rush`, `PvZ - Tempest Rush`,
  `PvZ - 2 Stargate Void Ray`, `PvZ - 3 Stargate Phoenix`,
  `PvZ - 2 Stargate Phoenix`, and `PvZ - AlphaStar Style
  (Oracle/Robo)`. A DT-into-Carrier transition or a Glaives-into-
  late-Stargate transition now falls through to the correct DT /
  Glaives bucket further down the tree. Mirror of the same OPENER-
  ordering principle applied across PvT in 0.8.1.
- **Fix #2 — new `PvZ - DT Opener` label.** A clean DT opener
  (Dark Shrine first, real Dark Templar lands, no Warp Prism) had
  no home in the PvZ tree — the only DT-related rule was
  `PvZ - DT drop into Archon Drop` which requires a Warp Prism, so
  plain DT builds fell through to `PvZ - Macro Transition
  (Unclassified)` (or, before fix #1, mis-fired as Carrier Rush
  when they added Stargate tech later). New rule fires when
  `DarkShrine` is built before 8:00 AND before any Stargate /
  Robotics Facility, with ≥1 real Dark Templar by 9:00. Catalog
  entry shipped in `data/build_definitions.json` and
  `apps/web/lib/build-definitions/pvz.ts`; the public catalog
  count goes from 101 to 102 entries.
- **Fix #3 — Zerg Nydus check now runs BEFORE Muta-rush check.**
  In `core/strategy_detector_opponent.py` the Muta rule fired on
  any Spire by 7:00 with `<45` drones; a Nydus opener that also
  added a Spire (late air follow-up, Brood Lord prep) mis-fired
  as 2 Base Muta Rush because the Muta check ran first and the
  Nydus check below it was dead code. The Pool-First branch had
  NO Nydus check at all — a Pool-First Nydus opener silently fell
  through to "Zerg - Pool First Opener", a macro-flavored catch-
  all that hid the all-in. Both branches now check `NydusNetwork`
  first, and the Pool-First branch has a real Nydus check.
- **Mirrors**: `SC2Replay-Analyzer/detectors/user.py` and
  `SC2Replay-Analyzer/detectors/opponent.py` in sync. Public
  catalogs (`data/build_definitions.json`,
  `apps/web/lib/build-definitions/pvz.ts`) updated to call out the
  "FIRST tech building" requirement on all six affected Stargate
  rules and to add the new DT Opener entry. The
  `DEFINITIONS_TOTAL` doc comment and the two arcade-test
  copy-paste references bumped from 101 to 102.
- **Tests**: 9 new regression cases in
  `tests/core/test_strategy_detector_opener_guards.py` cover all
  three mis-classifications plus positive controls (true Carrier
  Rush / true 2 Stargate Phoenix / true Muta Rush still match)
  plus the clean DT Opener path plus catalog presence. Full
  strategy-detector test suite: 128/128 passing.

## 0.8.2

### Fixed — PvT DT Drop and fast-3rd macro Blink no longer mis-tagged "7 Gate Blink All-in"
- **Two PvT replays were both labelled "7 Gate Blink All-in" when
  they were not:** a DT Drop opener that macroed into a multi-Gate
  Blink composition, and a fast-expand macro Blink that took a quick
  3rd Nexus before adding the extra Gateways.
- **DT Drop precedence.** The DT Drop rule sat BELOW the 7 Gate Blink
  All-in rule. A DT drop is a Twilight-first opener (the Dark Shrine
  requires a Twilight Council) that often researches Blink and keeps
  adding Gateways as the game goes long, so by 9:00 a DT-drop macro
  game satisfies the all-in signature (6+ Gateways + Blink +
  Twilight-first) and the all-in rule fired first. The DT Drop
  signature (Dark Shrine by 4:15, Robo by 4:30, real DT by 5:00, Warp
  Prism by 5:15) is now checked BEFORE the Gateway-count Blink rules.
  No genuine Blink all-in builds Dark Shrine + Robo + DT + Warp Prism
  inside 5:15, so the reorder cannot steal a real all-in.
- **Fast-3rd-Nexus guard on 7 Gate Blink All-in.** The
  `fifth_gateway_started < third_nexus_time` discriminator leaks when
  extra Gateways warp in around an already-fast 3rd Nexus. A 3rd Nexus
  STARTED before 6:00 is a macro commitment, never an all-in, so it is
  now excluded (`total_nexuses < 3 or third_nexus_time >= 360`). Those
  builds fall through to the 3 / 4 Gate Blink (Macro) labels. A LATE
  3rd Nexus (6:00 or later) after a 2-base Gateway commitment still
  classifies as the all-in, so the canonical case is unaffected.
- Mirror in `SC2Replay-Analyzer/detectors/user.py` in sync.
- Catalog prose updated for the new criteria
  (`core/build_definitions.py`, `data/build_definitions.json`,
  `apps/web/lib/build-definitions/pvt.ts`).
- Tests: 2 new regression cases in
  `test_strategy_detector_pvt_gateway_opener_variants.py` reproduce
  the reported replays — both classify as "7 Gate Blink All-in" on the
  old code and as the correct DT Drop / macro Blink label after the
  fix. All 121 strategy-detector tests pass.

## 0.8.1

### Fixed — Every PvT OPENER label now requires its labelled tech to be the FIRST tech building (full sweep)
- **Same OPENER ordering principle from 0.8.0 (Robo First) and the
  initial 0.8.1 Standard Charge Macro fix, now applied to every PvT
  rule that names a specific opener.** A label that calls itself
  "Phoenix into Robo" or "7 Gate Blink All-in" should fire only on
  builds where the named tech was the FIRST tech building -- a
  Robo-first opener that ADDS a Stargate / Twilight / TA later in
  the midgame is still a Robo First opener, not a Phoenix / Blink /
  Templar build. Without the ordering guards each of these labels
  would steal Robo-first replays from the Robo First branch below.
- **Phoenix into Robo + Phoenix Opener** (Stargate-first openers):
  added `sg_time < robo_time AND sg_time < twilight_time`. Robo-
  first openers that add a midgame Stargate + real Phoenix harass
  no longer mis-fire these labels.
- **7 Gate Blink All-in** (Twilight-first all-in): added
  `twilight_time < robo_time AND twilight_time < sg_time`. Robo-
  first openers that end up with 6+ Gateways and research Blink
  late no longer mis-fire this label.
- **8 Gate Charge All-in** (Twilight-first all-in): same Twilight-
  first guard. Robo-first openers with 7+ Gateways + late Charge
  no longer mis-fire this label.
- **2 Base Templar (Reactive/Delayed 3rd)** (Twilight-first
  Storm timing): same Twilight-first guard. Robo-first openers
  that add a late Templar Archives for Storm support no longer
  mis-fire this label.
- **2 Gate Blink (Fast 3rd Nexus)** (Twilight-first with Robo
  follow-up): same Twilight-first guard. Robo-first openers with
  a midgame Blink tech-switch no longer mis-fire this label.
- Rules that ALREADY had the OPENER guards in place (and continue
  to work as-is): `4 Gate Blink`, `3 Gate Blink (Macro)`,
  `3 Gate Charge Opener` (`twilight_time < robo_time AND
  twilight_time < sg_time`), `Stargate-into-Charge/Glaives/Blink`
  (`sg_time < twilight_time AND not pvt_robo_tech_before_twilight`),
  `Stargate Opener` (`sg_time < twilight_time AND sg_time <
  robo_time`), `Standard Charge Macro` (`twilight_time < robo_time
  AND twilight_time < sg_time` -- added earlier this version),
  `Robo First` (`robo_time < sg_time AND robo_time < twilight_time`
  -- 0.8.0). DT Drop and Proxy Stargate are time-window / location
  rules and don't need the opener ordering.
- All sentinel defaults (`9999` for "structure was never built")
  keep pure builds classifying correctly: e.g. a Stargate-first
  build with no Twilight has `twilight_time = 9999`, so `sg_time <
  9999` is trivially satisfied.
- Mirror in `SC2Replay-Analyzer/detectors/user.py` in sync.
- Catalog prose (`core/build_definitions.py`,
  `data/build_definitions.json`,
  `apps/web/lib/build-definitions/pvt.ts`) updated for all six
  rules to call out the "FIRST tech building" requirement and
  explain that Robo-first openers fall through to Robo First.
- Tests: 7 new regression cases in
  `test_strategy_detector_pvt_gateway_opener_variants.py` -- one
  per affected rule -- pin that Robo-first opener + the rule's
  trigger conditions classifies as Robo First, NOT the named
  label. Plus a positive
  `test_stargate_first_phoenix_into_robo_still_classifies` that
  asserts canonical Stargate-first Phoenix into Robo still
  classifies under the tightened guards. Full PvT detector test
  suite: 49/49 passing.

### Fixed — PvT Standard Charge Macro requires Twilight to be the FIRST tech building (not just before Stargate)
- **User-visible symptom**: the same Tourmaline LE 2026-05-20 16:48
  replay that 0.8.0 fixed (was: `PvT - Macro Transition
  (Unclassified)`, became: `PvT - Robo First`) flipped to a NEW
  wrong label after the 0.8.0 ship — `PvT - Standard Charge Macro`.
  The build: Gateway → Cyber → Robo at 2:43 (textbook Robo First
  OPENER), Twilight Council added later in the midgame for Charge
  support, 3+ bases by 7:30.
- **Root cause**: the 0.8.0 Standard Charge Macro fix replaced the
  strict `not has_building("Stargate", 9999)` guard with
  `twilight_time < sg_time`, intending to let Twilight-opener
  Charge macros with a midgame Stargate transition classify here.
  But that check is satisfied by *any* build where Twilight exists
  and no Stargate exists earlier — including Robo-first openers
  that add a Twilight Council later (`sg_time` defaults to 9999
  when no Stargate exists; `twilight_time` is well below 9999 for
  any build that researched Charge). The rule's COMMENT said
  "Standard Charge Macro only sees Twilight-first builds" but the
  code never enforced it. So Standard Charge Macro mis-fired on
  Robo-first openers before the Robo First branch below could
  claim the replay.
- **Fix**: add the missing ordering check
  `twilight_time < robo_time` to Standard Charge Macro, mirroring
  the symmetric Robo First rule which has BOTH
  `robo_time < sg_time` AND `robo_time < twilight_time`. The
  combined check now means what the label says: Twilight is the
  FIRST tech building (before both Robo and Stargate). Robo-first
  openers correctly fall through to Robo First. The legacy
  `SC2Replay-Analyzer/detectors/user.py` mirror carries the same
  guard.
- Build-definition catalogs (`core/build_definitions.py`,
  `data/build_definitions.json`,
  `apps/web/lib/build-definitions/pvt.ts`) updated: the rule
  description now spells out "Twilight Council is the FIRST tech
  building -- before any Robotics Facility AND before any
  Stargate" and notes that Robo-first openers go to Robo First
  instead.
- Tests: new regression
  `test_robo_first_opener_with_later_twilight_and_charge_is_robo_first_not_standard_charge_macro`
  locks in the Tourmaline LE shape — Robo at 2:43, Twilight at
  6:00, Charge at 7:00, 3rd Nexus at 7:30, no Stargate. The
  existing Twilight-opener positive tests
  (`test_standard_charge_macro_still_fires_with_no_stargate`,
  `test_standard_charge_macro_fires_with_twilight_opener_and_late_stargate`)
  still pass because they never had a Robo in the events list, so
  `robo_time = 9999` and `twilight_time < robo_time` is trivially
  satisfied. Full
  `reveal-sc2-opponent-main/tests/core/test_strategy_detector_pvt_*`
  suite: 42/42 passing.

## 0.8.0

### Fixed — PvT Robo First AND PvT Standard Charge Macro describe the OPENER, not the entire composition
- **The same anti-pattern was hiding in TWO rules.** After fixing
  Robo First, an audit (`grep "not has_building\\(.*9999\\)"`)
  found a sibling bug in PvT Standard Charge Macro: it carried
  the same strict `not has_building("Stargate", 9999)` guard,
  which excluded any Twilight-opener Charge macro that later
  added a Stargate. The fix is the parallel one: replace the
  "ever" guard with an opener-ordering check
  (`twilight_time < sg_time`), so Twilight-first Charge macro
  with a midgame Stargate tech-switch still classifies as
  Standard Charge Macro. Stargate-first builds remain caught
  by Stargate-into-Charge earlier in the chain.
- Audit scope: scanned every PvT / PvZ / PvP / opponent rule
  for the same anti-pattern. Findings:
  - `strategy_detector_pvt.py:195` — Standard Charge Macro
    `not has_building("Stargate", 9999)`. **Fixed**.
  - `SC2Replay-Analyzer/detectors/user.py:333` — legacy mirror
    of the same rule. **Fixed**.
  - `strategy_detector_pvz.py:99, :166` — time-windowed
    (`...480`, `...600`), not "ever". OK.
  - `strategy_detector_pvp.py` — uses `b["time"] < second_nexus`
    style time-bounded checks. OK.
  - `strategy_detector_opponent.py` — no `9999` literals in
    rule conditions (only as default function args). OK.
  - `strategy_detector_pvt.py:169` — `has_building("TemplarArchive", 9999)`
    is a POSITIVE existence check (rule requires the structure
    to exist + then orders against `third_nexus_time`). OK.

### Fixed — PvT Robo First describes the OPENER, not the entire composition
- **User-visible symptom**: a Robo First opener on Tourmaline LE
  (2026-05-20, 16:48 game) was getting tagged as
  `PvT - Macro Transition (Unclassified)`. The player opened
  Gateway → Cyber → Robo at 2:43 — a textbook Robo First opener — but
  later in the midgame added a Stargate (for Skytoss tech-switch /
  end-game Tempests / late Phoenix harass). The previous strict rule
  excluded any build with ANY Stargate from the Robo First bucket and
  shunted these replays into the catch-all.
- **Root cause**: `core/strategy_detector_pvt.py` carried a
  `not has_building("Stargate", 9999)` guard on Robo First. That
  guard was added on the premise that "a Stargate at any point makes
  the build a Robo+Sg hybrid, not the canonical pure-Robo opener" —
  but the catch-all rules below it (Phoenix into Robo / Stargate
  Opener) only fire on Stargate-led openers (Stargate before Robo),
  not on Robo-first openers with a later Stargate transition. The
  result: a Robo-first opener with a midgame Stargate had nowhere to
  land and fell through to Macro Transition (Unclassified).
- **Fix**: drop the strict guard. The Robo First label now describes
  the OPENER (Robo is the first tech building — before any Twilight
  Council AND before any Stargate), not the entire composition. The
  remaining ordering checks (`robo_time < sg_time`,
  `robo_time < twilight_time`) keep Stargate-led hybrids out:
  ```
  if (has_building("RoboticsFacility", 390)
          and robo_time < sg_time
          and robo_time < twilight_time):
      return "PvT - Robo First"
  ```
  Stargate-first builds are caught earlier by Phoenix into Robo (when
  a real Phoenix is on the field) or Stargate Opener (the catch-all
  for Stargate-first with no Phoenix), so Robo First only sees
  Robo-first openers.
- Build-definition catalogs (`core/build_definitions.py`,
  `data/build_definitions.json`, `apps/web/lib/build-definitions/pvt.ts`)
  updated to describe Robo First as an opener label, including the
  fact that midgame Stargate transitions don't reclassify the opener.
- Tests:
  - `test_strategy_detector_pvt_stargate_variants.py`: the
    `test_robo_first_does_not_fire_when_stargate_exists` regression
    that pinned the old "any Stargate disqualifies" behaviour is
    rewritten to assert the opposite — Robo-first opener + later
    Stargate transition IS Robo First. A companion
    `test_stargate_first_then_robo_is_not_robo_first` keeps the
    Stargate-first case routed to Stargate Opener.
  - `test_strategy_detector_pvt_gateway_opener_variants.py`: two new
    regression cases lock in the Tourmaline LE replay shape
    (Gateway → Cyber → Robo at 2:43, Stargate at 9:00) and a
    sibling early-midgame Stargate variant (Robo 3:20, Stargate
    5:30, no Phoenix on the field).
  - Full reveal-sc2-opponent-main detector suite: 225/225 passing
    (the pre-existing `test_integrity_sweep` failure is unrelated
    to detection).

## 0.7.9

### Changed — Widen PvT DT Drop buffer to +60s; tighten DT/Ghost/BC Rush opponent labels
- **PvT DT Drop buffer widened from +30s to +60s.** 0.7.8 calibrated
  the DT Drop rule against the Peruano replay (Shrine 3:13, Robo 3:32,
  DT 3:51, Prism 4:11) with a +30s buffer. That window was tight to
  the reference and dropped slightly-slower legitimate DT Drops. New
  cutoffs (observed + ~60s):
  ```
  has_building("DarkShrine", 255)         # 3:45 -> 4:15
  has_building("RoboticsFacility", 270)   # 4:00 -> 4:30
  count_units("DarkTemplar", 300) >= 1    # 4:30 -> 5:00
  count_units("WarpPrism", 315) >= 1      # 4:45 -> 5:15
  ```
  Mid-game DT-tech additions (Shrine going down after 4:15) still
  don't match. New regression test
  `test_slower_dt_drop_still_classifies_within_60s_buffer` pins a DT
  Drop landing ~30s behind Peruano.
- **DT Rush / Ghost Rush / BC Rush opponent labels tightened.** The
  same too-loose-cutoff pattern that caught DT Drop was hiding in
  three opponent-side rules: each fired on a SINGLE building existing
  by a generous cutoff, with no follow-up unit check. They now require
  the build's signature unit to actually be on the field within a
  realistic harass / attack window:
  ```
  Protoss - DT Rush:  Dark Shrine by 5:00 + real DT by 6:00
                      (was: Dark Shrine by 7:30 alone)
  Terran - Ghost Rush: Ghost Academy by 5:30
                      (was: Ghost Academy by 6:30 -- standard Bio macro
                      adds the Academy after 6:00 for snipes/EMPs)
  Terran - BC Rush:    Fusion Core by 5:30 + real Battlecruiser by 7:30
                      (was: Fusion Core by 6:30 alone -- any mech-into-
                      late-game-BC macro built FC for end-game)
  ```
  Same fix mirrored in both `core/strategy_detector_opponent.py` and
  the legacy `SC2Replay-Analyzer/detectors/opponent.py`.
- Build-definition catalogs (`core/build_definitions.py`,
  `data/build_definitions.json`, `apps/web/lib/build-definitions/pvt.ts`)
  updated to document the new windows and unit-presence requirements.

## 0.7.8

### Changed — PvT DT Drop windows calibrated against a real replay; Blink rules count Gateways before the 3rd Nexus
- **DT Drop calibrated to a real reference replay.** The 0.7.8 first
  pass tightened the DT Drop rule to require an actual DarkTemplar
  (no more Robo First mistagging) but kept loose 8-10 minute windows
  on Dark Shrine / Robo / Warp Prism. A reviewer provided a real PvT
  DT Drop replay (Peruano, Taito Citadel LE, 2026-05-11) whose
  observed timings are MUCH faster than that:
  ```
  Dark Shrine started   3:13
  RoboticsFacility      3:32
  First DarkTemplar     3:51
  WarpPrism on field    4:11
  ```
  The rule is now calibrated to each observed signal + ~30 seconds
  of buffer:
  ```
  has_building("DarkShrine", 225)         # was 480 (8:00)
  has_building("RoboticsFacility", 240)   # was 540 (9:00)
  count_units("DarkTemplar", 270) >= 1    # was 600 (10:00)
  count_units("WarpPrism", 285) >= 1      # was 540 (9:00)
  ```
  Slower-tech builds that pick up DT tech later in the midgame don't
  fit the fast-tactical DT Drop signature and now fall through to
  `PvT - Robo First` / `Macro Transition (Unclassified)` instead.
- **Blink rules count Gateways STARTED before the 3rd Nexus**, not
  Gateways by a fixed 7:30 timer. The "X Gate Blink" label names
  itself after the player's macro-vs-aggression commitment — how
  many Gateways went down BEFORE the 3rd Nexus broke ground. A fast
  3rd Nexus that's followed by more Gateways post-expansion is a
  3 Gate Blink macro game (only 3 Gates pre-3rd), not a 4 Gate Blink.
  A delayed 3rd Nexus with 4+ Gateways pushed out pre-expansion IS a
  4 Gate Blink even if no further Gateways follow.
  ```
  gates_before_third_nexus = count_started_before(
      buildings, "Gateway", third_nexus_time,
  )
  # 4 Gate Blink:           gates_before_third_nexus >= 4
  # 3 Gate Blink (Macro):   gates_before_third_nexus == 3
  # 2 Gate Blink (Fast 3rd): gates_before_third_nexus == 2 (+ Robo + 3+ Nexuses)
  ```
  `third_nexus_time` defaults to 9999 when no 3rd Nexus is ever
  taken, so 2-base Blink builds still classify against their total
  Gateway count — and the 7 Gate Blink All-in rule above keeps
  catching mass-gate 2-base aggression first.
- Both the modular `core/strategy_detector_pvt.py` detector and the
  legacy `SC2Replay-Analyzer/detectors/user.py` mirror carry the
  new cutoffs.
- Build-definition catalogs (`core/build_definitions.py`,
  `data/build_definitions.json`, `apps/web/lib/build-definitions/pvt.ts`)
  updated with the new timing thresholds and the gates-before-3rd-Nexus
  wording.
- Tests: three new Blink-gate-counting regression cases pin (a) fast
  3rd Nexus + 3 gates pre-expansion + 5 gates total → 3 Gate Blink,
  (b) delayed 3rd + 4 gates pre-expansion → 4 Gate Blink, (c) 2 gates
  pre-expansion + Robo + 3 Nexuses + Blink → 2 Gate Blink (Fast 3rd
  Nexus). The canonical DT Drop test is rebuilt against the Peruano
  reference replay's actual timings. Full PvT suite: 213/213 passing.

### Fixed — PvT DT Drop requires an actual Dark Templar on the field
- **User-visible symptom**: a normal Robo First game on Tourmaline LE
  (2026-05-20, 16:48 game) was getting tagged as `PvT - DT Drop`. The
  player opened Robotics Facility first, made Warp Prisms for Immortal
  drops, and added a Dark Shrine later in the game for late-game DT
  support — but never actually warped in a Dark Templar to drop.
- **Root cause**: the PvT - DT Drop rule fired on three signals alone
  (`has_building("DarkShrine", 540) AND has_building("RoboticsFacility", 600)
  AND count_units("WarpPrism", 600) >= 1`) and never asked "did any
  actual DarkTemplar exist?" Warp Prisms are heavily used for Immortal
  drops in Robo First builds, and a Dark Shrine added in the late
  midgame still satisfied the 9-minute window. So any Robo First with
  a late Dark Shrine got mistagged.
- **Fix** in `core/strategy_detector_pvt.py` (and the legacy
  `SC2Replay-Analyzer/detectors/user.py` mirror — both kept in sync):
  - Dark Shrine must be STARTED by 8:00 (was 9:00). A real DT-drop
    opener commits to the Shrine early so the first DT pops by ~8:30
    and the drop lands by 8:30-9:30.
  - Robotics Facility must be up by 9:00 (was 10:00).
  - Warp Prism on the field by 9:00 (was 10:00).
  - **NEW**: at least one real (non-hallucinated) DarkTemplar by 10:00.
    `count_units` is prereq-aware so Sentry hallucinations cannot
    satisfy this — the actual unit has to have a Dark Shrine in the
    buildings list at its appearance time.
  - This mirrors the PvZ "DT drop into Archon Drop" rule which has
    required `count_units("DarkTemplar", 540) >= 3` since the matchup
    rules first landed.
- Build-definition catalogs (`core/build_definitions.py`,
  `data/build_definitions.json`, `apps/web/lib/build-definitions/pvt.ts`)
  updated to spell out the new conditions in the user-facing rule
  description.
- Tests: four new regression cases in
  `test_strategy_detector_pvt_gateway_opener_variants.py`:
  - User's reported scenario (Robo First + late Dark Shrine + Warp
    Prism + 0 DTs) → `PvT - Robo First`, not DT Drop
  - Early-Shrine + Warp Prism but still 0 DTs → not DT Drop
  - Canonical DT Drop opener (Shrine 6:00, Robo 5:20, Prism 8:00, DTs
    by 8:20) → still classifies as DT Drop (positive case)
  - Sentry-hallucinated DarkTemplar event before the Shrine exists →
    doesn't satisfy the unit-count guard
- Full PvT detector suite: 210/210 passing.

## 0.7.7

### Fixed — PvT build classification keys on which Twilight upgrade was FIRST, not just "exists by 9:00"
- **User-visible symptom**: a 3-base PvT macro game where the player
  researched Blink FIRST and Charge later (both before 9:00, no
  Stargate) was getting tagged `PvT - Standard Charge Macro`.
  Reported on the Taito Citadel LE / Ruby Rock LE replays from
  2026-05-19 — the Macro Breakdown showed Blink in the upgrade
  roster but the matchup label said "Standard Charge Macro." The
  build is a Blink macro game that happens to add Charge late; the
  label has to reflect which upgrade the player committed to first.
- **Root cause**: three PvT rules in
  `core/strategy_detector_pvt.py` keyed only on
  `has_upgrade_substr("Charge"|"Blink", 540)` ("does upgrade X exist
  by 9:00?") without checking which upgrade was the FIRST one
  researched out of the Twilight Council. A Blink-first /
  Charge-later replay matched the Standard Charge Macro signature
  (Charge exists + 3+ Nexuses + no Stargate) and the rule fired
  before the Blink rule below it ever got a chance.
- **Fix** mirrors the first-upgrade ordering pattern the
  `Stargate-into-Charge / Glaives / Blink` rules and the
  `3 Gate Charge Opener` rule already use. The PvT detector now
  hoists the first-Twilight-upgrade calculation up to the top of the
  matchup block (it was previously only computed for 3 Gate Charge
  Opener) and three rules consume it:
  - **PvT - Standard Charge Macro** now requires Charge to be the
    FIRST Twilight upgrade. A Blink-first build correctly falls
    through to `3 Gate Blink (Macro)` / `4 Gate Blink` instead.
  - **PvT - 7 Gate Blink All-in** now requires Blink to be the FIRST
    Twilight upgrade. A Charge-first / Glaives-first build that
    later adds Blink with 6+ Gateways on 2 bases is a hybrid timing
    push, not a Blink all-in.
  - **PvT - 8 Gate Charge All-in** now requires Charge to be the
    FIRST Twilight upgrade. A Blink-first build with 7+ Gates on 2
    bases is not a Chargelot all-in.
- The legacy parallel detector
  (`SC2Replay-Analyzer/detectors/user.py`) carries the same three
  guards now — both implementations agree.
- Tests: three new regression cases added to
  `test_strategy_detector_pvt_gateway_opener_variants.py`. The
  user's specific scenario (Blink first, Charge later, 3 Nexuses,
  no Stargate, Twilight-first) now classifies as
  `PvT - 3 Gate Blink (Macro)`; the inverse (Charge first, Blink
  later, same shape) still classifies as `PvT - Standard Charge
  Macro`. Full PvT detector suite: 206/206 passing.

## 0.7.6

### Fixed — Build classification uses building START times, not finish times
- `event_extractor.py` emits TWO events per Protoss / Terran building
  the player constructs: `subtype="init"` when construction starts
  (UnitInitEvent) and `subtype="born"` when construction completes
  (UnitBornEvent ~build_time later). Plus `subtype="morph"` for
  in-place morphs (Gateway → WarpGate, Lair, Hive, …). Every strategy
  rule that counted "N+ Gateways by 9:00" or indexed into the sorted
  Nexus list to find "the 3rd Nexus" was reading BOTH events
  unfiltered, which caused two symptoms:
  - **Over-counting** in `sum(1 for b in buildings ...)` patterns. A
    Gateway that finished by 9:00 contributed two events (init + born),
    so 3 actual Gateways registered as 6 — and the `gate_count_6min
    >= 6` threshold fired on as little as 3 real Gateways.
  - **Finish-time leakage on indexed access**. A naive
    `sorted([b["time"] ...])[2]` for the 3rd Nexus could resolve to
    the 2nd Nexus's BORN time (~370s) instead of the 3rd Nexus's
    INIT time (~500s) when the 3rd was taken late, so a rule
    comparing "5th Gateway started < 3rd Nexus taken" would compare
    against the wrong moment entirely.
- Centralized start-time helpers in
  `core/strategy_detector_helpers.py` (and a mirror in
  `SC2Replay-Analyzer/detectors/base.py`):
  `start_times(buildings, name)`,
  `start_times_excluding_main(buildings, name)`,
  `count_started_before(buildings, name, t)`,
  `nth_base_start(buildings, name, n)`,
  `base_count_at(buildings, name, t)`. All filter to subtype `init`
  or `morph` (morph = the only event for Lair / Hive / WarpGate /
  Orbital / Planetary, and IS the start of the new building).
- `DetectionContext.gate_count_6min` / `gate_count_530` and every
  inline `sum(...)` / `sorted([...])` pattern across the PvT, PvZ,
  PvP, and opponent detectors (both the modular `core/` set and the
  legacy `SC2Replay-Analyzer/detectors/` mirrors) now routes through
  the helpers, so the entire classifier reads start times
  consistently.
- **Direct user-visible consequence**: PvT "7 Gate Blink All-in" now
  excludes any replay where the 3rd Nexus was STARTED before the 5th
  Gateway was started -- a player can drop the 3rd Nexus and keep
  adding Gateways while it is still building (~100s Nexus build
  time) and those Gateways are still macro reinforcement, not
  all-in production. Build-definition catalogs (Python +
  `apps/web/lib/build-definitions/pvt.ts`) updated to spell out
  "STARTED" in the description.
- Tests: two new regression cases in
  `test_strategy_detector_pvt_gateway_opener_variants.py` model the
  full production event flow (init + born per building) and pin the
  start-time semantic -- a late-3rd 7-Gate all-in must still
  classify, and Gateways added DURING the 3rd Nexus's construction
  must NOT promote a macro build into the all-in bucket.

## 0.7.5

### Changed — Macro Breakdown emits per-window supply blocks
- `macro_score.detect_supply_block_windows` replaces the aggregate-only
  `_supply_block_seconds` view with a list of `{start, end, blocked_sec}`
  windows. The Active Army & Workers chart binds its translucent
  vertical bands to these so users see WHEN each block happened, not
  just the total seconds. The "you blocks" / "opp blocks" legend
  entries now match what's actually plotted.
- The aggregate `supply_blocked_seconds` is derived from the windows so
  the headline "Supply blocked" stat below the chart and the per-window
  bands can never disagree.
- The dead `raw.leak_windows` / `raw.opp_leak_windows` keys (economic
  SQ-leak periods that nothing consumed and the chart legend never
  actually described) are no longer shipped on the wire. Recompute on
  any earlier replay to pick up the new field.

## 0.7.4

### Changed — Macro Breakdown samples at 10 s cadence
- `_downsample_stats_events` now buckets at 10 s instead of 30 s,
  matching sc2reader's native PlayerStatsEvent cadence. The Active
  Army & Workers chart in the web SPA's Macro Breakdown drilldown
  scrubs at 3× the previous resolution — every hover lands on a
  real sample.
- `unit_timeline` is filtered to the same 10 s sample times so the
  chart line, the hover tooltip, and the unit composition roster
  beneath the chart still agree at every tick.
- Wire payload grows ~4 kB per side on a 30 min game (still well
  within the 5000-entry validator cap → ~13 h headroom).
- macro_score is still computed on the FULL native stream first, so
  leak detection / SQ / penalty calculations are unaffected.

## 0.7.2

### Fixed — Opponent Protoss "Robo Opener" no longer fires on Twilight-first builds
- The opponent-side Protoss classifier tagged any build with a
  Robotics Facility before 6:30 as `Protoss - Robo Opener`,
  regardless of whether a Twilight Council had already gone down.
  A standard 2-Gate Expand Blink build with a follow-up Robo
  (Twilight first, Robo later) was being mis-labelled, hiding the
  Blink/Twilight context the user needs to react.
- The Robo Opener branch now requires the earliest Robotics
  Facility to predate the earliest Twilight Council, matching the
  user-side PvZ / PvT definitions ("FIRST tech building"). A
  Twilight-first build with a later Robo falls through to the
  Blink All-In / Standard Expand / Standard Macro branches
  instead.
- Both detector copies the agent ships
  (`reveal-sc2-opponent-main/core/strategy_detector_opponent.py`
  and `SC2Replay-Analyzer/detectors/opponent.py`) carry the same
  guard, and the build-definition catalogs (Python + the web
  `apps/web/lib/build-definitions/protoss.ts`) document the
  "FIRST tech building" requirement.
- New regression suite
  `test_strategy_detector_protoss_robo_opener_opponent.py` pins
  three scenarios: the user-reported Twilight-first 2-Gate Expand
  Blink with a later Robo (must NOT classify as Robo Opener), a
  true Robo-first opener with no Twilight (must still classify as
  Robo Opener), and a Robo-before-Twilight build with both present
  (must still classify as Robo Opener), so the discrimination
  can't silently regress.

## 0.6.10

### Fixed — PvT "3 Gate Charge Opener" no longer steals Blink-first openers
- The `PvT - 3 Gate Charge Opener` classifier fired on a boolean
  "did Charge get researched by 9:00?" check together with
  Twilight-first ordering, but never compared Charge timing against
  Blink. A replay where the player opened Blink first and added
  Charge later matched both the Charge rule and the `3 Gate Blink
  (Macro)` / `4 Gate Blink` rules directly below it, and the Charge
  rule won by file order — mistagging Blink openers as Charge.
- The fix mirrors the existing Stargate-into-X ordering pattern:
  gate the label on Charge being the FIRST Twilight upgrade
  (vs Blink / Glaives). Both detector copies the agent ships
  (`reveal-sc2-opponent-main/core/strategy_detector_pvt.py` and
  `SC2Replay-Analyzer/detectors/user.py`) carry the same guard now.
- New regression suite `test_strategy_detector_pvt_gateway_opener_variants.py`
  covers Charge-first, Blink-first / Charge-after (the reported bug),
  Blink-only, Blink-first with 4+ Gateways, and the Standard Charge
  Macro promotion path so the discrimination can't silently regress.

## 0.6.5

### Fixed — Fresh `game_key` on every match start, including fast back-to-back queues
- `LiveClientPoller` now clears `_current_game_key` (and
  `_match_started_at_ms`, `_last_in_progress_display_time`) the moment
  it transitions into `MATCH_ENDED`. Previously the per-match identity
  lingered until the next `IDLE` / `MENU` event or until the next
  `MATCH_LOADING` branch ran. When SC2's loading screen for the NEXT
  match flipped by inside one poll window (default 1 s) the poller
  skipped `MATCH_LOADING` entirely, landed straight on
  `MATCH_STARTED`, and the `if self._current_game_key is None` guard
  in that branch kept the just-finished match's key on the new
  match's envelope.
- The downstream consequence streamers reported: the OBS opponent
  widget kept showing the previous opponent through the entire next
  match (the cloud + overlay correctly treated game N+1 as a
  continuation of game N because gameKeys matched), and the scouting
  widget never appeared for game N+1 because the post-game
  `live.result` was still set so `ScoutingWidget` short-circuited
  via its `isRealPostGame` check.
- Regression test `test_fast_back_to_back_match_synthesises_fresh_game_key`
  pins the new identity-reset semantics so any future refactor of the
  state machine can't quietly resurrect the bug.
- The web client also gained a defense-in-depth fallback: the
  `useClearStalePostGameOnGameKeyChange` hook now drops stale `live`
  when the envelope's opponent name differs from `live.oppName`, so
  streamers still running an old agent build self-heal on the
  client side.

## 0.6.4

### Fixed — Live bridge resets and re-announces match identity on server / region switch
- `LiveBridge` now tracks the streamer's own toon-handle region byte
  via the new `set_user_toon_handle()` setter. Whenever the leading
  byte changes (NA → EU, EU → KR, etc.) the bridge:
  - drops `_current` so the prior server's per-match context can't
    bleed into the new server (a still-in-flight Pulse callback for
    the old match would otherwise merge into the new one and
    poison its `streamerHistory`);
  - prepends a synthetic `MENU` + `MATCH_LOADING` envelope pair to
    the next active-phase event so cloud overlay clients clear stale
    state and the new gameKey-change effect fires on the
    Browser-Source side, even when the SC2 client jumps from
    `MATCH_ENDED` straight to `MATCH_IN_PROGRESS`.
- The synthetic prelude carries `synthetic: true` for telemetry.
  Both envelopes are tagged with the new match's `gameKey` so the
  cloud's enrichment cache and the overlay widget renderer treat
  the post-switch match as a brand-new identity.
- A real `IDLE` / `MENU` event still serves as a transition
  boundary — the bridge clears the pending-transition flag so a
  natural main-menu return doesn't double-fire the prelude.
- Region detection lives in a new shared
  `sc2tools_agent.live.region.region_from_toon_handle` helper so
  the live bridge and the existing uploader agree on the byte →
  label mapping (NA / EU / KR / CN / SEA).

User-visible effect: streamers who switch SC2 servers mid-stream
no longer see the prior server's opponent dossier (Opponent +
Scouting widgets) frozen on their OBS scene through the next
match. Widgets refresh automatically on the new server's first
queue, matching the behaviour the cloud-side fix in
[apps#185](https://github.com/ReSpOnSeSC2/sc2tools/pull/185)
already implemented for the post-game `overlay:live` payload.

## 0.6.3

### Fixed — opponents stuck on `1-S2-1-XXXXX TOON` instead of upgrading to a Pulse character id
- The in-process SC2Pulse resolver used to cache misses **forever**.
  An opponent whose first replay landed during a transient
  sc2pulse.nephest.com outage (or hit the agent's tight 4 s
  backfill timeout) was permanently blackholed for the rest of
  the agent process — every subsequent replay against the same
  opponent short-circuited on the cached miss, so the cloud
  never received a `pulseCharacterId` and the Opponents tab kept
  rendering them as the raw toon handle with the dim "TOON"
  badge. Negative-cache entries now expire after 10 minutes
  (env override `SC2TOOLS_PULSE_NEG_CACHE_SEC`); the next replay
  past the TTL re-probes Pulse from cold.
- The backfill (older-replays) wall-clock cap was bumped from
  4 s to 10 s. Pulse routinely answers in 6–8 s under load; the
  old budget was tight enough that legitimate-but-slow responses
  registered as misses on every catch-up scan, which combined
  with the now-fixed unbounded negative cache to permanently
  prevent resolution. New env override
  `SC2TOOLS_PULSE_BACKFILL_TIMEOUT_SEC` for operators who want
  to tune the cap without touching the live-game budget.
- Every replay with a parsed `opp.handle` now emits an explicit
  `pulseLookupAttempted: true` bit on the opponent payload, so
  the cloud can distinguish "agent didn't try" from "agent tried
  and Pulse said no" — feeds the new cloud-side backfill cron's
  freshness window.
- Resolver gained a `force_refresh` keyword the cloud-side
  recovery path uses to bypass both caches; agent paths default
  to `force_refresh=False` so the local positive cache still
  short-circuits the common case.

User-visible effect: opponents that previously rendered as
`1-S2-1-437579 TOON` on sc2tools.com/app eventually flip to a
clickable nephest character link, either on the next replay
upload or within one cloud backfill cycle (whichever comes
first), without the user needing to take any action.

## 0.6.2

### Fixed — SC2Pulse search response parsing
- **The Live Game Bridge was reporting `confidence=0.0 mmr=None` for
  every opponent** because the agent only looked for the
  `character` sub-object at one location in the SC2Pulse
  `/character/search` response. Modern Pulse responses nest the
  character under `hit.members[0].character` (newer servers) or
  `hit.members.character` (older), so `ch.get("name")` returned None,
  no candidate scored above zero, and every lookup fell into the
  low-confidence stub branch.
  Mirroring the legacy `stream-overlay-backend` `pickHitCharacter`
  helper, we now check all four locations — `hit.character`,
  `hit.members[0].character`, `hit.members.character`, and the hit
  itself — so the agent picks the candidate from whichever shape
  Pulse returns. Race counts are sourced from the analogous member
  object so the race tiebreaker also fires correctly.
- The race normalizer now accepts the truncated forms (`Terr`,
  `Prot`, `Rand`, `Zerg`) the SC2 client occasionally reports in
  some locales. Previously these silently dropped the race-bonus
  score during candidate disambiguation.

User-visible effect: opponents who play ranked 1v1 now resolve to a
real MMR + league pre-game in the OBS overlay, instead of every
match showing "Profile lookup unavailable". Streamers who sit on
unranked or fresh accounts that genuinely don't have ladder rows
still see the honest "Profile lookup unavailable" — that case is
unchanged.

## 0.6.1

### Changed — Cloud-only default transport (PR #165)
- The Live Game Bridge now ships **cloud-only by default**. The
  `OverlayBackendTransport` (HTTP POST to `localhost:3000`) is no
  longer constructed at boot — fresh installs send zero traffic to
  the legacy local overlay backend.
- New `SC2TOOLS_LOCAL_OVERLAY_URL` env var re-enables the legacy
  transport for users running the self-hosted
  `reveal-sc2-opponent-main/stream-overlay-backend` product. Set it
  to e.g. `http://localhost:3000` to wire both transports.
- Boot logs now report `live_transport_cloud_only=true` (default) or
  `live_transport_local_overlay_enabled url=...` (opt-in) so you can
  tell at a glance which path your install is using.
.

## 0.6.0

### Added — Live Game Bridge (PR #163)
- New `sc2tools_agent.live` module: polls Blizzard's localhost SC2
  client API at 1 Hz, fuses with SC2Pulse for opponent profile data,
  and pushes outbound to both the local overlay backend (HTTP) and
  the cloud (HTTP). The opponent and scouting widgets now populate
  BEFORE the game starts and persist throughout the match — no more
  "widgets only appear after the replay uploads" gap. See
  `docs/live-game-bridge.md` for the architecture reference.
- New `--no-live` flag to disable the bridge for diagnostics. Replay
  watcher / uploader / heartbeat / GUI all keep working unchanged.
- Voice readout reliability fixes: persisted browser-unlock so the
  user only gestures once per profile; silent-failure detection +
  retry; structured diagnostics POSTs to a new
  `/api/voice/diagnostics` endpoint on the overlay backend.
- New `LiveMetrics` singleton + 5-minute periodic dump to agent.log
  for per-source success rates and EWMA latencies.
## 0.5.13

### Note on the version jump (0.5.10 → 0.5.13)
- `agent-v0.5.11` and `agent-v0.5.12` were tagged but the on-disk
  ``__version__`` bump never landed. The installer filename came from
  the tag (correct) but the binary inside reported itself as 0.5.10
  in heartbeats / crash reports / the updater, putting users in a
  soft update loop. v0.5.13 is the first release where the on-disk
  ``__version__`` matches the tag again.

### Fixed (originally targeted at v0.5.11; PR #157)
- **Active Army chart no longer renders a phantom late-game opponent
  spike.** A streamer's PvZ replay showed the opponent army line
  stay near zero for ~13 minutes and then jump vertically to ~9 200
  in seconds — caused by the SPA reconstructing the army value via
  a fragile cascade (``unit_timeline`` → build-order cumulative +
  timeline-derived deaths → food-supply heuristic) that fell through
  to the cumulative count without applying any deaths whenever the
  timeline was sparse for one side. The agent now ships
  ``army_value`` per ``PlayerStatsEvent`` row (sc2reader's
  authoritative ``minerals_used_active_forces +
  vespene_used_active_forces``) and the SPA chart binds to it
  directly. The derived/heuristic paths are now hard-clamped to
  ``ARMY_FALLBACK_CAP`` so neither can synthesise a vertical spike
  even on legacy uploads.

### Fixed (originally targeted at v0.5.12; PR #159)
- **WarpGate-warped units no longer dropped from the SPA's roster.**
  ``extract_macro_events`` populated ``unit_lifetimes`` only on
  ``UnitBornEvent``, but WarpGate-warped units (Adept, Stalker,
  Sentry, Zealot, Templar) emit ``UnitInitEvent`` + ``UnitDoneEvent``
  and never fire ``UnitBornEvent``. The reference replay had 41
  Adepts warped via WarpGate — every one was missing from the
  composition snapshot. The extractor now accepts EITHER
  ``UnitBornEvent`` OR ``UnitDoneEvent`` as the canonical "alive"
  tick for non-building units, deduped by uid.
- **``_clean_building_name`` no longer corrupts ``"Zergling"``.**
  The helper used a global ``raw_name.replace("Zerg", "")`` —
  ``"Zergling"`` literally starts with the substring ``"Zerg"`` so
  the prefix was eaten and the name became ``"ling"``, falling
  out of every downstream lookup. Same bug corrupted
  ``"SprayZerg"`` → ``"Spray"`` and ``"SupplyDepotLowered"`` →
  ``"SupplyDepoted"``. The prefix-strip now requires a CamelCase
  boundary; ``"Zergling"`` and ``"SprayZerg"`` preserved while
  legacy ``"ZergHatchery"`` still folds to ``"Hatchery"``.

### Fixed (PR #160)
- **Overlords are now counted in the alive roster.** sc2reader's
  ``army_value`` (which the SPA chart binds to) includes Overlord
  supply cost and so does sc2replaystats's Army Value chart.
  Pre-fix, ``Overlord`` was in ``SKIP_UNITS`` so the roster's
  Σ(unit_cost × count) drifted ~100/Overlord below the chart's
  army number for every Zerg game. Removing the skip makes chart
  and roster agree.
- **Overseer (and any morph-from-supply unit) now appears.** With
  Overlord tracked, the existing UnitTypeChange rename path handles
  Overlord → OverlordCocoon → Overseer automatically. A
  defence-in-depth ``elif`` was added so any future morph chain
  whose parent is in SKIP_UNITS but whose target is army-relevant
  surfaces in the timeline.
- **Ability/projectile "units" skipped from the roster.** Reaper
  ``KD8Charge``, Sentry ``ForceField``, Oracle ``OracleStasisTrap``,
  and Disruptor ``DisruptorPhased`` (Purification Nova projectile)
  all fire ``UnitBornEvent`` with a player pid but have no
  meaningful cost-catalog entry. Added all four to ``SKIP_UNITS``
  so they no longer pollute the Macro Breakdown roster as
  broken-icon chips.
- **Building stance forms (``SporeCrawlerUprooted``,
  ``CommandCenterFlying``, etc.) can't leak in via morph creation.**
  The new morph-creation handler in the UnitTypeChange branch now
  rejects names ending in ``Uprooted`` / ``Flying`` / ``Lowered``
  AND any uid already in the building-lifetimes tracker, so the
  airborne/uprooted form of a building can't show up as a "unit".

### Re-import note
- Re-import (or click Recompute on the Macro Breakdown panel) on any
  replay extracted by an earlier agent to pick up the new
  ``army_value`` field, the alive-Adept tracking, and the corrected
  Zergling / Overlord / Overseer roster contents. Legacy uploads
  keep rendering through the SPA's clamped derived path — no
  vertical spike, but the absolute army number stays an
  approximation until re-uploaded.

## 0.5.10

### Fixed
- **Build classification no longer flips on Sentry hallucinations.** A
  Sentry's Hallucination ability spawns Phoenix / VoidRay / HighTemplar
  / Archon / Immortal / Colossus / WarpPrism events that look identical
  to real production in the replay event log. The classifier was
  therefore mis-tagging 2-base Charge / Templar PvT games as
  `PvT - Phoenix Opener` or `PvT - Phoenix into Robo` whenever the
  opponent's Sentry tossed a single hallucinated Phoenix.
  Every pre-built build now requires its tech-structure prerequisite
  (Phoenix → Stargate, HighTemplar → Templar Archives,
  Carrier/Tempest/Mothership → Stargate + Fleet Beacon,
  Colossus/Disruptor → Robotics Facility + Robotics Bay, etc.). A unit
  only counts toward classification when at least one prerequisite
  alternative was *started* before the unit appeared. The structure
  does not need to still be standing — a Stargate killed at 5:00 still
  qualifies a Phoenix at 7:00, since the construction event lives in
  the event log permanently.
  Re-process affected replays after upgrading: re-import via the agent
  to overwrite the stored `myBuild` value with the freshly-computed
  classification.

## 0.5.9

### Fixed
- **Sync date range filter now takes effect IMMEDIATELY on Save.**
  Previously, already-queued uploads continued to fly out for up to
  ~30 seconds after a filter change, and watchdog FS events could slip
  through during the watcher's 10-second poll window. The runner now
  (a) drops queued uploads outside the new window via the new
  `UploadQueue.drain_outside_filter()`, (b) triggers an immediate
  watcher sweep via `ReplayWatcher.request_immediate_sweep()`,
  (c) re-evaluates previously-filtered replays against the new window,
  all before `save_state()` commits to disk so the on-disk state never
  diverges from the in-memory state on a partial-Save crash. The
  upload queue itself now re-checks the filter at the moment of the
  network call as defense-in-depth, so a job that beat the runner's
  drain (worker had already pulled it off the queue mid-batch) is
  still skipped before paying the HTTPS round-trip.
- The runner used to gate its post-Save `request_full_resync()` call
  on `cleared_filtered > 0`. A user transitioning from "All time" to
  "Current season" on a fresh-ish state has zero "filtered" entries
  to clear, so the resync ping never fired and the watcher only
  noticed the new filter ~10 seconds later on its next periodic
  sweep. Now resync + immediate-sweep are unconditional on every
  filter change.
- `save_state` previously ran BEFORE the filtered-entries cleanup
  loop, so the in-memory state and the disk state diverged for the
  rest of the runner's lifetime. On agent restart the stale
  "filtered" entries reloaded from disk and were never re-evaluated.
  Now `save_state` runs ONCE per Save click, after every in-memory
  mutation completes.

### Added
- `UploadQueue.drain_outside_filter() -> int` walks the queue and
  drops every job whose `game.date_iso` falls outside the active
  sync filter, returning the count dropped. Re-enqueues survivors in
  their original submission order. Persists `state.uploaded` once
  atomically if anything was dropped. Surfaces drops via the
  existing `_on_failure` callback (with a new `_FilteredOutError`
  sentinel exception) so the GUI's Recent uploads feed shows
  filter-drops alongside transport / rejection failures.
- `ReplayWatcher.request_immediate_sweep()` runs one extra sweep on
  a daemon thread without waiting for the periodic poll. Spawns a
  fresh thread per call; safe to call repeatedly because the
  watcher's `_inflight` set + `state.uploaded` dedupe prevent
  doubled work, and the new `_roots_lock` serialises concurrent
  rediscovery passes.
- `GuiUI.show_settings_status(msg)` lets the runner surface a
  post-Save toast in the Settings tab. The runner uses it to show
  the filter apply summary (active filter label, queued uploads
  dropped, previously-filtered replays re-eligible). Auto-clears
  after 5 seconds via a Qt single-shot timer.
- The dashboard status card now displays the active filter chip
  (e.g. "Watching for replays · Filter: Season 67"). Reads from a
  tracked `_active_filter_label` set on Save (not the live combo
  widget) so an in-progress edit never briefly mislabels the chip.

## 0.5.8

### Added
- **Batch upload + multi-worker upload pipeline.** The watcher's parse
  output now feeds into the cloud's batch endpoint
  (`POST /v1/games {games: [...]}`) instead of one HTTP request per
  game. Default batch size 25, default concurrency 1. With the
  cloud's 120 req/min rate limit that's `1 worker × 2 req/sec ×
  25 games/req = 50 games/sec sustained` — about 25× the v0.5.7
  ceiling on the same rate-limit budget. Configurable via
  `SC2TOOLS_UPLOAD_BATCH_SIZE` and `SC2TOOLS_UPLOAD_CONCURRENCY`
  env vars. Per-game `accepted` / `rejected` arrays in the response
  are mirrored back into `state.uploaded` independently, so a
  partial-success batch (e.g. 23 accept + 2 schema-reject) marks
  each game correctly.
- **Backpressure on `UploadQueue.submit`.** Pre-v0.5.8 the bounded
  queue silently dropped jobs when full. Process-mode parsers
  produce 5–10× faster than the upload thread can drain, so
  ~80% of replays were getting dropped + re-parsed on the next
  sweep, looping indefinitely. The new behaviour blocks the parse
  done-callback thread until the queue has space (5-min safety
  timeout). No data loss.
- **`Retry-After` honored on 429.** When the cloud rate-limits an
  upload, the API client reads the `Retry-After` header (RFC 7231
  integer-seconds form, with HTTP-date fallback) and sleeps that
  long instead of falling through to the 0.5/1/2-second exponential
  backoff. Clamped at 60 s so a buggy / hostile server can't hang
  the agent indefinitely.
- **`Pause` now stops the parser, not just uploads.** Pre-v0.5.8 the
  watcher kept submitting parses in the background while paused;
  process mode made that flood the log even after the user clicked
  Pause expecting silence. Pause now short-circuits both the
  periodic sweep and live watchdog file-create events.
- **Process-pool parse mode is back, default-on, with three guardrails.**
  The watcher's parse executor now picks `ProcessPoolExecutor` by default,
  giving the user's `parse_concurrency` slider real CPU parallelism (≈5×
  wall-clock speedup measured on a 12k-replay backfill — see
  `README.md#parse-pool-modes` for the table). The v0.3.9 attempt at
  this shipped enabled and crashed every PyInstaller-frozen child during
  spawn with `BrokenProcessPool`; v0.3.10 disabled the feature entirely.
  v0.5.8 re-enables it with:
  1. `_parse_in_worker` calls `bootstrap_analyzer_path()` as the FIRST
     thing it does on the child side, unconditionally re-bootstrapping
     the analyzer roots onto the child's `sys.path`. This fixes the
     direct cause of the v0.3.9 incident: the child importing
     `core.sc2_replay_parser` before the parent's `sys.path` mutations
     reached it.
  2. A boot-time synthetic probe in `_probe_process_pool()` spawns one
     child, asks it to import `core.sc2_replay_parser`, and waits 30 s
     for an answer. On any failure the agent logs
     `parse_pool_probe_failed err=<reason>` and falls back to
     `ThreadPoolExecutor` for the rest of the session — no crash, no
     stuck queue.
  3. A runtime catch in `_submit_parse` swaps the live process pool for
     a thread pool if `BrokenProcessPool` ever surfaces mid-session
     (e.g., a worker OOM during an unusually long replay). The replay
     re-submits transparently and the rest of the session continues
     in threading mode.
- New env var `SC2TOOLS_PARSE_USE_PROCESSES`: set to `0`, `false`,
  `off`, or `no` (case-insensitive, whitespace-tolerant) to force
  threading mode and skip the boot probe entirely. Anything else —
  including unset — keeps process mode enabled.
- New log line `parse_pool_mode=process|thread workers=N reason=…`
  emitted exactly once at boot, plus a second one if the runtime
  fallback triggers. Greppable triage signal for support.

### Changed
- `_on_worker_done` now takes the submitted path string as an explicit
  second argument (captured in the `add_done_callback` closure) so the
  inflight set is cleared even when `future.result()` raises. Without
  this a worker crash would orphan the inflight entry and the replay
  would never re-submit on a subsequent sweep. Threading-mode behaviour
  is unchanged.
- `ReplayWatcher.stop()` reads the live executor under `_executor_lock`
  before shutting it down — the runtime fallback can swap it
  mid-session and the previous read would have raced.

### Fixed
- Inflight-set leak when a parse worker raises before producing a
  result tuple. Previously the `finally:` block in `_on_worker_done`
  was unreachable because the early `return` in the `except`
  branch ran first. Now the `finally:` runs unconditionally and uses
  the captured submission path.

### Migration notes
- No state-file schema changes. State written by 0.5.7 loads
  unchanged in 0.5.8.
- The Settings tab's parse-concurrency slider now caps at
  `min(cpu_count, 12)` instead of `cpu_count`. Beyond ~8-12
  parse workers, additional workers just queue up parsed games
  in memory while the upload pipeline drains at its rate-limited
  ceiling — the cap keeps the slider honest. Users with a saved
  `parse_concurrency_override > 12` (e.g. 32 from running the old
  uncapped slider) get auto-clamped to 12 on next agent boot with
  a `parse_concurrency_clamped from=N to=12` log line. Power
  users on a self-hosted cloud API with a higher rate limit can
  bypass the cap entirely via the `SC2TOOLS_PARSE_CONCURRENCY`
  env var.
- If you experience instability on the new default, set
  `SC2TOOLS_PARSE_USE_PROCESSES=0` and please open an issue with the
  `parse_pool_probe_failed` line from `agent.log` so we can debug
  the underlying spawn issue on your install.

