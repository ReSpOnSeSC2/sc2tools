# Changelog

All notable changes to `@sc2tools/agent` go here. Newest first.

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

