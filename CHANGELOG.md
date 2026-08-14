# Changelog

All notable changes to SC2 Tools are recorded here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project
uses [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

Windows Agent releases are tagged `agent-vMAJOR.MINOR.PATCH`. The
`agent installer` GitHub Actions workflow builds the Windows installer
from those tags and attaches the `.exe` and `.sha256` to the
corresponding GitHub Release.

## [Unreleased]

### Fixed

- **The Skill Fingerprint now follows the dashboard date range** — the card
  previously read a fixed window of your 50 most recent games in a matchup and
  ignored the filter bar entirely, so changing the time frame did nothing.
  It now reads the same cohort as every other analyzer card (date range,
  ladder-vs-custom, regions, map, exclude-too-short) and refreshes when new
  replays arrive. Your race and matchup still come from the card's own picker,
  and the build, MMR, opponent-strategy, leak and macro-score filters stay out
  because each of them would redefine one of the tracks it measures — the card
  now says so when one is active. A range too narrow to rate shows progress
  toward each track and a one-click way back to all time, instead of a dead
  end.

### Changed

- **Skill Fingerprints now explain and reward practiced variety, timing shape,
  and matchup balance** — build repertoire separates detected names from an
  Shannon-entropy effective count and adds One-Trick and Signature Pilot tiers;
  pace classification recognizes timing-window, mid/late mastery, late mastery,
  and genuine Two-Speed distributions from real replay durations; matchup
  scoring now has five named states around 5-, 7.5-, and 10-point landmarks.
  The expanded 175-combination archetype space, signed matchup score, real
  time-band evidence, and in-product methodology make every label reproducible
  without estimates or placeholder data.
- **The Skill Fingerprint archetype is far more precise, and now differs per
  matchup** — every matchup used to report the same name because a third of the
  archetype was a race-wide measure that could not vary, and the remaining
  bands were broad enough to funnel most players into one of 36 cells. The
  matchup track now compares the selected matchup against your own other two;
  build variety counts *effective* builds, so ten builds with one favourite is
  no longer "Creative Genius"; and game length reads the distribution rather
  than the mean, adding a two-speed type for players who genuinely mix quick
  all-ins with long macro games. Names are now composed from the two tracks
  where you are furthest from ordinary, with a neutral name when nothing stands
  out, and the card explains which traits produced yours. Existing archetype
  names will change.

- **Trends now shows filtered total playtime overall and by exact matchup** -
  the existing game-length view sums real recorded replay time, follows every
  active analyzer filter, and offers compact weeks, days, hours, hours-and-
  minutes, or minutes-and-seconds display modes on mobile and desktop.

- **Trends now highlights the strongest and weakest MMR days in the selected
  view** - a compact, responsive strip beneath MMR progression shows the
  highest verified daily MMR gain and biggest daily MMR loss, including the
  local date, measured-game count, and record. The calculation honors every
  active filter while keeping separate accounts, ladder races, and the user's
  own Battle.net regions from creating false swings.

- **Build authors can safely remove their own builds from Community** — owner-
  only controls now appear on Community cards and build pages, with an impact
  review followed by a separate acknowledgement confirmation. Unpublishing
  keeps the private build, rules, notes, replay matches, public URL, and vote
  history available for a later republish; deleting the private source also
  removes its public listing so orphaned Community builds cannot remain live.

- **Full Re-sync is substantially faster without relaxing its safety limits**
  â€” agent 0.15.18 caches the replay inventory, refills parser capacity from a
  newest-first backlog, forms fuller historical API batches, skips redundant
  detail writes, and defers historical SC2Pulse enrichment to the existing
  bounded cloud backfill. The 500-item ingest backpressure gate, bounded parse
  and upload queues, two-request network ceiling, adaptive batch reduction,
  Retry-After handling, and live-game priority remain in place.
- **Private original replay backups now drain independently and survive agent
  restarts** â€” accepted analysis records durably enqueue their exact
  `.SC2Replay` backup before advancing the local sync cursor. One background
  archive worker resumes unfinished tasks after restart, shares the same
  network ceiling as ingest, and removes work only after a stored,
  already-stored, or terminal per-file acknowledgement. Server object checks
  plus local size/SHA-256 matching preserve stale-marker self-repair.
- **Long-running import progress is truthful and controllable** â€” quiet or
  rate-limited work is shown as background sync with its remaining count,
  never as a false completion. Inventory failures remain unknown instead of
  becoming zero, stalled jobs recover on real movement, and they can still be
  cancelled without starting a duplicate import.

- Simplified the public infrastructure-cost page by removing internal growth
  scenarios, tightening MongoDB cost wording, and improving mobile spacing.

- Fixed Cloudflare R2 cost monitoring so S3 list/bulk-delete aliases and
  non-billable Sippy/notification configuration reads are assigned correctly
  instead of appearing as unclassified activity.

- **Infrastructure costs are now explained with the real production split** —
  the landing and support pages separate the single Render API instance,
  MongoDB Atlas, domain renewal, included Vercel/Clerk allowances, and
  usage-based Cloudflare R2 storage. A sanitized live snapshot now reports R2
  bytes, objects, verified original replays and classified operations alongside
  SC2 Tools' logical/allocated database size, Atlas disk used versus capacity
  in binary GiB, and Atlas charges posted in the current cycle with their
  through-date and category split. Posted charges remain visibly separate from
  the projected monthly Atlas run rate. When that projection is available, the
  combined estimate is the **$8.25/month** non-Mongo fixed cost plus projected
  Atlas and estimated R2; otherwise it is clearly labeled as the
  **$65.19/month** planning fallback plus the live R2 estimate. Missing provider
  data is never reported as zero usage or a completed invoice. Admin Health
  and Storage now surface replay/R2 readiness, database allocation, Atlas disk
  capacity, billing freshness and credential-expiry warnings without exposing
  provider credentials or identifiers.

### Fixed

- **Community builds now publish under the owner's chosen name by default** -
  profile display name (or BattleTag name) is used unless the author explicitly
  selects **Post anonymously**. Both publish dialogs and save-time build editors
  preview and preserve the current choice, legacy anonymous listings remain
  anonymous, and failed or still-syncing visibility updates no longer show a
  false Published/private state. Anonymous rows omit stable owner identifiers
  and stay out of later named author profiles while retaining owner-only replay
  counts and removal controls.

- **Custom-build replay totals now agree everywhere** - My Builds and an
  author's Community cards read the same durable classification stored on each
  replay, rather than re-running a smaller recent sample. Community cards now
  label vote scores as votes, show private replay totals only to the build's
  owner, and show loading or temporary unavailability instead of a false zero.

- **The cloud API now bounds the memory bursts that caused intermittent 502s** -
  repeated overlay reconnects, chat polling, SC2Pulse lookups, replay-detail
  analyses, and analysis-corpus pages are now coalesced, size-limited,
  admission-controlled, and cancelled when their clients leave. Ordinary
  dashboard visits no longer load the large analysis corpus, and request logs
  no longer record bearer, overlay, chatbot, or device-pairing credentials.

- **Custom-build replay matching now shows real progress and completion** -
  Save and Save & Reclassify are distinct actions, background matching remains
  visible after the request is queued, completed results refresh automatically,
  and failures or unavailable replay analyses are reported without discarding
  existing build tags. Reclassification retries temporary storage interruptions
  with bounded backoff instead of silently appearing to do nothing. The
  ambiguous "NOT by" timing rule is now labeled "Not built before" and explains
  that the event may happen at or after the selected time.

- **Creating or reclassifying a custom build no longer exhausts API memory** -
  live rule previews now scan a bounded recent sample in small pages, hydrate
  only the build-log side being evaluated, cancel superseded editor requests,
  and share a strict object-read ceiling. Saving queues a durable,
  memory-bounded full-history match in the background, with restart recovery
  and safe coalescing for rapid edits, instead of retaining hundreds of full
  replay-analysis blobs inside one web request.

- **Full Re-sync no longer exhausts the production API's memory** — replay
  ingestion now admits one memory-heavy batch per API process and safely asks
  additional agents to retry without losing files. Validation no longer
  duplicates full replay payloads in memory, processed batch entries are
  released incrementally, historical reuploads no longer launch live-session
  refresh work, and dashboard/Arcade history is served as narrow 2,000-row
  cursor pages instead of one 20,000-row response. Agent 0.15.20 treats this
  backpressure as an ordinary capacity delay without shrinking its batch size
  or reporting false upload failures.

- **Full Re-sync now repairs old Resume-from-Replay results** — StarCraft II's
  definitive Take Command marker is uploaded as a non-competitive quarantine
  record, including legacy IDs previously tied to the same local replay. These
  sessions are excluded from builds, opponents, session records, and public
  Ladder Meta by default. Build history offers an optional **Show
  replay-resume tests** audit view without adding their synthetic outcomes back
  to any totals. Ships with **agent 0.15.17** (`agent-v0.15.17`) and bundled
  replay engine 1.5.8.

- **Zerg Hatch/Pool openers no longer count a later third as "3 Hatch Before
  Pool"** — opener detection now compares the third Hatchery's actual start
  directly with the Spawning Pool instead of using a loose early-game cutoff.
  Recomputing a replay's Macro Breakdown refreshes the corrected opponent
  strategy after installing agent 0.15.17.

- **Ladder Pulse no longer presents Mineral Float's ranking weight as a bank
  balance** — the signal now reports the observed number of readings over 800
  minerals, so 20 readings are not mislabeled as a 2,000-mineral float.

- **Queue Thought map advice is limited to a verified current ladder pool** —
  edition suffixes such as `LE` are normalized without conflating numbered
  maps, and stale or emergency fallback pools suppress this one card. Older
  map-pool games remain available to every other history and analysis view.

- **Analyzer game filters now default to ranked 1v1 and stay applied** —
  fresh and legacy sessions start with Ladder + 1v1 selected, explicit All
  choices persist, and opening an opponent profile or reading dashboard KPIs
  no longer brings filtered-out custom/team games back. Ranked/custom now
  follows the replay's matchmaking metadata instead of its map name, while
  normalized match formats keep FFA out of Team. Ships with **agent 0.15.15**
  (`agent-v0.15.15`) for newly uploaded replay classifications.

- **Resume-from-replay sessions no longer count as ladder games** — the
  Windows agent now recognizes StarCraft II's replay-resume marker before it
  trusts the copied win/loss metadata. These files are intentionally skipped
  and shown separately in import progress, while ordinary ladder replays are
  unchanged. Ships with **agent 0.15.13** (`agent-v0.15.13`).

### Added

- **Admin infrastructure costs and capacity guidance** - the authenticated
  Infrastructure page now combines Cloudflare R2 usage and estimated cost,
  MongoDB Atlas storage/CPU and projected charges, and Render plan/CPU/memory
  into three compact provider cards. Sustained capacity signals produce clear
  watch or upgrade notices plus a persistent Admin navigation indicator;
  stale data and isolated spikes never trigger purchase advice. Provider
  credentials and internal account, bucket, cluster, and service identifiers
  remain server-only. These are in-admin notices, not email alerts or final
  provider invoices.

- **Private original replay library and downloads** — Opponent dossiers and
  individual game-analysis pages now offer an uncluttered `.SC2Replay`
  download action backed by a private Cloudflare R2 archive. The Settings
  **Backups & data** tab reports private archive coverage and exact re-sync
  guidance. Existing users update to **agent 0.15.16**
  (`agent-v0.15.16`) and run **Re-sync** once; dashboard and desktop prompts
  remain actionable until that one-time scan is requested. Historical files
  already deleted from the PC remain unavailable, while future accepted games
  archive automatically.

- **Timestamped Twitch and YouTube links for both player perspectives** — the
  opponent dossier's full game list and each game detail page now show compact,
  grouped **You** and **Opp** platform icons whenever a verified matching VOD
  exists. Twitch actions use the platform's purple with matching hover and
  keyboard-focus highlights. Links seek directly to the game's start, use
  saved streamer accounts
  plus SC2Pulse's participant/public account associations, and omit missing or
  unverified archives instead of guessing. New uploads carry the exact replay
  start with **agent 0.15.14** (`agent-v0.15.14`, replay engine 1.5.7); older
  games remain supported using replay end time minus duration.

- **30-second stream chat cleanup** — on-stream chat messages now default
  to disappearing after 30 seconds. A clearer message-lifetime control in
  Settings offers one-click 15-second, 30-second, one-minute and longer
  choices (plus **Never**), while the Stream Dock chat history is unchanged.

- **Live viewer counts in the Stream Dock** — the dock's chat header
  now shows how many people each platform you're streaming to has
  watching right now, next to the connection dot that's already there,
  plus the combined audience across all of them on the right. Counts
  come straight from the platforms — Twitch, Kick and YouTube are read
  server-side (none of them allow a browser to ask directly), and
  TikTok's number comes off the webcast connection the relay already
  holds for chat.

  A platform we can't get a truthful number from shows no number at
  all rather than a misleading zero, and the total is marked
  `watching+` when that happens, so "0 viewers" always means zero
  viewers. Refreshes every 45 seconds, pauses while the dock is hidden,
  and several open docks or Browser Sources share one lookup per
  channel.

- **Automatic OBS scene switching** — the desktop agent can now change
  OBS scenes on its own, using the game state it already tracks from
  StarCraft II's local client API. A match loading cuts to your
  gameplay layout; returning to the menu cuts back to a downtime
  layout. Every phase maps to a scene of your choosing, and every slot
  is optional, so you can configure it as simply as two scenes.

  A one-click builder in the agent's Settings tab creates those two
  layouts from the sources you already have — a *Between Games* scene
  with a big camera, a readable chat column, a small game-capture inset
  so viewers can see when you're queueing, and the new full-screen
  backdrop; plus an *In Game* scene with the game full-screen and the
  camera tucked in a corner. It never touches your existing scenes.

  Off by default. Works with OBS on the same PC or on a separate stream
  PC over the LAN. Ships with **agent 0.15.9** (`agent-v0.15.9`) — see
  `apps/agent/CHANGELOG.md` for the agent-side details.

- **StarCraft II backdrop scenes for OBS** — new full-canvas Browser
  Sources at `/overlay/<token>/scene/<name>` for Between Games,
  Starting Soon, BRB and intermission. A hex console lattice over a
  perspective ground plane with an accent horizon, tinting to your live
  opponent's race. Entirely procedural — no Blizzard artwork — and
  built to a strict performance budget so it can sit under a game
  capture all night. Copy the URLs from Settings → Overlay →
  Full-screen scenes, or export a still/looping MP4 with
  `npm run scenes:render` if you'd rather not run a live Browser
  Source.

### Fixed

- **Stream Dock counts current viewers, not lifetime viewers** — TikTok
  now reads the current `roomUser` audience and no longer substitutes its
  cumulative unique-viewer field. YouTube only accepts a count when the
  same live renderer explicitly identifies it as "watching now," so a live
  stream with its concurrent audience hidden cannot leak lifetime views
  into the dock. Slow, older browser responses also cannot overwrite a
  newer current snapshot, and the dock labels the combined figure
  "watching now" for clarity.

- **Stream Dock Starting Soon and BRB now stay above automatic OBS scene
  changes** — the scene builder adds one shared, transparent-until-selected
  manual cover to the top of both generated layouts. The phase switcher can
  keep the scene underneath current without replacing a card the streamer
  selected manually. Agent 0.15.12 automatically and non-destructively adds
  that cover to older generated scenes whenever the enabled scene switcher
  connects to OBS, including auto-started/minimized installs; custom layouts
  and added sources are preserved. The manual **Update my scenes** action
  remains available as a recovery path. Ships with **agent 0.15.12**
  (`agent-v0.15.12`).

- **Stats ticker quoted a stale opponent MMR** — the ticker's
  "NOW PLAYING" segment announced the rating from the *last* time you
  played that opponent while the opponent card at the top of the same
  scene showed their current one, so a returning opponent who had
  climbed since your last meeting appeared twice on screen with two
  different numbers (4,620 in the ticker, 5,407 on the card). The
  ticker read only the cloud's saved last-observed MMR, skipping the
  SC2Pulse profile rating every other surface prefers. That precedence
  — Pulse's current-season rating first, the stored last-encounter
  value only as a fallback — now lives in one helper the ticker, the
  opponent card and the voice readout all share. The "MMR GAP" segment
  reads the same resolved rating, so it no longer sizes the gap (or
  picks "upset material" vs "protect the rating") off a months-old
  number, and a `0`/`null` rating from either source now drops the MMR
  clause instead of rendering "0 MMR".

- **OBS auto scene switching actually switches now** — four fixes to
  the agent-side switcher shipped in 0.15.9. Enabling the feature
  without touching the scene dropdowns persisted six explicit "don't
  switch" rows and silently disabled it (an all-blank map now falls
  back to the default In Game / Between Games mapping, and the panel
  shows that default instead of lying); scenes created by "Build my
  scenes…" were invisible to the switcher's cached scene list until a
  reconnect (it now re-reads the list before refusing, and the build
  auto-fills the dropdowns); enabling from Settings needed a hidden
  agent restart (Save now starts the switcher immediately); and every
  auto-switch misclassified its own OBS echo as the streamer taking
  manual control, logging bogus suppressions. Ships with
  **agent 0.15.10** (`agent-v0.15.10`) — details in
  `apps/agent/CHANGELOG.md`.

- **Backdrop scene preview in Settings showed "SC2 Tools hit a critical
  error"** — the preview framed the scene with `sandbox="allow-scripts"`,
  which gives the framed document an opaque origin. Chrome makes
  `navigator.serviceWorker` *throw* there rather than be absent, and the
  usual `"serviceWorker" in navigator` guard still reports true, so the
  service-worker registration in the root layout threw and took the
  whole document down to the global error page. The preview now grants
  `allow-same-origin` (it frames our own page; the sandbox still blocks
  navigation, popups, forms and modals), and the registration survives
  an unreadable `navigator.serviceWorker` anywhere it mounts. Overlay
  routes now skip service-worker registration entirely — an OBS Browser
  Source gains nothing from an app-shell cache and a stale shell is what
  their no-store headers exist to prevent.

- **Backdrop scenes no longer spin in `?demo=1`** — the sample countdown
  was derived from `Date.now()` during render, so every render handed
  the countdown effect a new deadline, which re-armed its timer and set
  state again: ~50 timer re-arms a second, and a slow frame away from
  React's "Maximum update depth exceeded". The demo countdown is now a
  fixed sample value that arms no timer and polls no studio state,
  which also keeps `scripts/render-scene.mjs` exports seamless — a
  running clock would have differed between the loop's first and last
  frame.

- **Net MMR matchup coverage is now explicit** — race cards label each
  accepted replay-to-replay result as one measured game and now reconcile it
  against that race's complete filtered game count. Per-race and footer
  diagnostics use mutually exclusive reasons, including sequence-ending games
  with no later MMR reading, so gaps such as “66 of 75 games measured” explain
  themselves without implying that game counts drive the signed race totals.

- **Opponent MMR leader cards now rank by net result** — the gain card
  selects the largest positive net MMR and the loss card selects the most
  negative net MMR. Gross MMR won/lost remains available in the tables, but
  a high-volume opponent can no longer occupy both headline cards.

- **Agent updater no longer sticks on an old version after a release
  ships** — the API's GitHub release feed could keep telling installed
  agents "you're up to date" on a version the website had already
  replaced (observed live: agents held at 0.15.5 while the site
  offered 0.15.8). Two causes, both fixed: a release published before
  the installer workflow attached its `.exe` was resolved past — and
  the older release then cached for the full 10 minutes, now shortened
  to 2 minutes while a newer release's assets are pending; and a
  failing GitHub fetch (typically unauthenticated rate-limiting on a
  shared-IP host) served the stale cached version forever, now capped
  at 6 hours before falling back to the manually published feed. The
  feed also reads the sha256 from GitHub's own asset digest (skipping
  the sidecar download), revalidates with `If-None-Match` so unchanged
  polls cost no rate-limit quota, and offers the newest *verifiable*
  release instead of blanking when the very newest is missing its
  checksum. Deploys should also set `GITHUB_TOKEN` on the API service
  (see `docs/cloud/SETUP_CLOUD.md`).

### Added

- **Opponent MMR impact drill-downs** — each Net MMR matchup race card
  now opens a live, filterable opponent table showing who took the most
  MMR from you and who you took the most from, with search, minimum-pair
  filtering, eight ranking modes, and pagination. The Opponents tab also
  surfaces authoritative gain/loss leaders plus sortable net, gross-won,
  and gross-lost MMR columns. Every value comes from the same verified,
  consecutive ranked-1v1 replay-pair pipeline as the matchup totals, so
  opponent rows reconcile exactly to their race summary; no mock or
  inferred W/L data is used. Both opponent tables use a compact
  mobile/desktop layout, with W/L and win rate ahead of the MMR columns
  so the core record stays visible earlier while scrolling.

- **Creep tumor tracking for Zerg games** — the macro breakdown and
  the game page's Mechanics panel now show how many creep tumors you
  planted, split into Queen-cast vs self-spread (classified at
  construction start, before the burrow morph makes the two forms
  indistinguishable), when the first tumor went down, and how many
  were killed. Sits next to inject efficiency as the second Zerg
  macro mechanic; informational only, the macro score is unchanged
  (engine 1.5.6 / agent 0.15.7). Shown once a game is parsed or
  recomputed by the updated agent — older breakdowns hide the row
  instead of showing a fake zero.

- **Map replay tracks units lost, their price tag, and trade
  efficiency** — the map replayer now shows a live "units lost" panel
  per player that follows the scrubber: how many units each side has
  lost so far, the total minerals and gas those units were worth, a
  breakdown of exactly what died (with unit icons and counts), and a
  trade-efficiency ratio (resources the opponent lost per resource
  you lost — above 1.00× means you traded up). Prices come from the
  build optimizer's balance-patch dataset, with morphed units
  (Banelings, Ravagers, Brood Lords…) valued at their full invested
  cost including the consumed unit. Deaths that are really tech
  spending never count as losses: the Drone consumed by each Zerg
  structure and the Templar consumed by an Archon merge (both emit
  real deaths in the replay's tracker stream) are recognized and
  excluded, so Zerg isn't charged a "lost drone" per building and
  the drone-loss count matches the workers-killed numbers other
  replay sites report. Games re-synced with agent 0.15.5+ carry
  exact killer attribution (payload v4) for this; older payloads use
  same-tick pairing of drone deaths with building starts. Works on
  every already-synced game — no re-sync needed.

- **Opponents tab groups all of a player's names into one row** — a
  new "Group same player" toggle (default on) merges opponent rows
  that SC2Pulse links to the same human: characters on the same
  Battle.net account (name changes, region alts) and community-
  verified players across accounts (revealed barcodes). The grouped
  row leads with the player's most-known name — the SC2Pulse
  revealed/pro name when there is one, otherwise the readable name
  they've played the most games under — with merged W/L/games/win
  rate, the freshest MMR on record, and a "+N names" chip that
  expands a per-name breakdown; each name stays clickable through to
  its own deep dive, and search matches hidden aliases too. Powered
  by a new `GET /v1/opponents/pulse-links` endpoint backed by a
  shared, cross-user `pulse_character_links` cache over SC2Pulse's
  batch `group/character/full` API (≤500 ids/request, bounded
  upstream budget per call, week-long linkage TTL, day-long negative
  TTL) so the linkage for any opponent is fetched once, ever, across
  all platform users.

- **Opponent deep dives merge the whole player, not just one name** —
  with "Group same player" on, opening any grouped opponent loads the
  profile with `mergeLinked=1`: games, totals, by-map/by-strategy
  rollups, phase envelopes, H2H timelines, predictions, and the
  all-games table span EVERY name SC2Pulse links to that player, as
  if all their games were played on one account. The header leads
  with their most-known name, a "Plays as" line breaks down each
  name's own W-L, and the all-games table's players column shows
  which name each game was played under. Opening the profile from any
  linked identity lands on the same merged page; turning the toggle
  off (or any linkage failure) falls back to the classic
  single-identity profile.

### Removed

- **Median key timings card dropped from the opponent profile** — the
  long per-building timing grid took up a large amount of vertical
  space (30 cards in some matchups) without being actionable, so the
  section and its `MedianTimingsGrid` component were removed. The API
  still returns the timing payloads for other consumers.

### Changed

- **Build mix and opponent-strategy cards redrawn as cadence matrices** —
  the "Your build mix over time" and "Strategies you're facing" cards
  replaced their 100% stacked area chart with a build × period matrix:
  each cell shows the actual game count (darker = more games), rows
  double as the legend with a recent-share shift chip, idle periods
  stay visible as gaps, and a games-per-period strip anchors the
  timeline. At the 1-8 games/day these feeds actually run at, the old
  share-based areas interpolated single games into full-height spikes;
  the matrix plots the counts themselves. The tap/hover breakdown
  panel remains and now includes per-build W-L for the period.

- **Map performance panels now lead with the map's artwork** — each
  panel in "Map performance over time" shows the real map thumbnail
  next to its name and record, with the existing initials tile as
  fallback for maps without artwork.

- **Daily Pulse no longer tracks unresolved barcode opponents** — the
  Nemesis Watch and Ladder Rival cards skip opponents whose display
  name is a barcode (IIlIlI…) unless a resolved SC2Pulse character id
  confirms who is behind the bars; an unverifiable identity isn't
  worth a headline card.

### Fixed

- **Overlay rank widget shows your real ladder league, not an
  MMR guess** — the rank card derived its league and tier by bucketing
  your MMR against a fixed threshold table (`leagueFromMmr`), so a
  5,124-MMR player who Blizzard actually placed in Master 1 saw
  "Master 2", and the estimate knew nothing about between-season
  placements (a former Grandmaster sitting in Master 1 while the new
  season's GM ladder is still locked would be mislabelled every game).
  The widget now reads your true current-season league and tier
  straight from your SC2Pulse ladder team — the same source the
  opponent dossier already uses — pinned to the region of the account
  that just played. The MMR-threshold table remains only as a
  fail-soft fallback for games with no toon handle or when SC2Pulse is
  unreachable. Grandmaster now renders with no tier (it's a single
  top-N bucket, not a tiered league). Lands on the next game upload.

- **Chrono/MULE efficiency can no longer read over 100%** — the
  expected chrono and MULE counts in the macro breakdown were
  computed from Nexus/Orbital alive-time divided by the energy-regen
  cooldown alone, ignoring that each Nexus and each Orbital Command
  finishes with 50 energy banked — one cast available the moment it
  exists. A player who spent that starting energy (as they should)
  routinely cast more than the regen-only estimate, so the panel
  showed things like "11 of ~8 expected (138% chronos)". Expected
  now credits one free cast per Nexus/Orbital (engine 1.5.5 / agent
  0.15.6), raising typical expected counts by the number of casters
  and making the efficiency thresholds correspondingly — and
  correctly — a touch stricter. Applies on the next parse or
  macro-breakdown recompute.

- **Map replay worker counts no longer stick at 0** — the replay
  engine read the worker count from a field name that only exists in
  this project's downstream JSON (`food_workers`) instead of the raw
  sc2reader attribute (`workers_active_count`), so the replayer HUD
  showed "0 workers" for both players all game. Fixed at parse time
  (engine 1.5.3 / agent 0.15.4); for games synced before the fix the
  web replayer now counts the live worker units in the payload
  instead, so old replays read correctly without a re-sync.

- **Map trend panel Y-axis labels no longer clip** — the per-map
  trend charts rendered "100%" and "50%" ticks truncated to "0%"
  because the axis gutter was too narrow; the gutter is now wide
  enough for the full labels.

- **Daily Pulse opponent cards now open the player's dossier** — the
  Open link on the Nemesis Watch and Ladder Rival cards previously
  just switched to the Opponents tab, landing on the list instead of
  the opponent it named. Clicking now deep-links straight into that
  opponent's profile.

- **Map replayer clock now runs on real game time** — the playback
  clock, HUD stats timing, and scrubber length were built from
  Blizzard game-time seconds (16 frames/s) while every unit track
  used real seconds (22.4 frames/s on Faster), so a 16:04 game
  scrubbed to 22:29 and the final ~40% of the timeline was dead air.
  The replay engine now derives `game_length` and stats timestamps
  from the same real-seconds timebase as the tracks (**agent
  0.15.3**), and the web sanitizer clamps stretched lengths from
  older v1/v2 payloads so existing uploads read correctly without a
  re-sync.

- **Lifted Command Centers no longer vanish (and their workers no
  longer float)** — buildings were only ever drawn at their
  construction site, so a CC that lifted off and landed at an
  expansion showed at the old base forever; the workers actually
  mining at the new base had no town hall to snap to and drifted
  as the long-standing "floating SCVs/probes" artifact. The replay
  engine now tracks lift-off Land commands against the player's
  live selection and records each landing point plus building death
  times (playback payload v3); the replayer flies the structure to
  its landing spot at flying-building speed, anchors mining, vision,
  and gas logic at the building's *current* position, and removes
  destroyed buildings at the recorded moment. The worker-to-hall
  mining snap radius is also widened (9 → 12 cells) so outer-patch
  workers present as mining instead of idling.

### Added

- **Map replayer zoom & pan** — scroll or pinch to zoom (1×–8×,
  anchored at the cursor), drag to pan while zoomed, double-tap or
  the ⤢ button to reset, with on-canvas +/− controls. Works with
  mouse, trackpad, and touch.

- **Unclassified builds no longer headline the trending/insight
  surfaces** — the detector's fallbacks ("Unclassified - Protoss",
  "PvP - Macro Transition (Unclassified)", "Terran - Standard Play
  (Unclassified)") are catch-alls for games that matched no build
  signature, not builds a player can choose to queue with, yet they
  could be crowned by every form/trending highlight: the dashboard
  Daily Pulse could serve "Build heating up — PvP - Macro Transition
  (Unclassified) is on form" (and the "Dust it off" rusty-build card),
  the Ladder Pulse recent-form pane could headline one, the ladder-meta
  movement card could promote one as New/Rising/Meta, and the overlay
  ticker could print it as SIGNATURE BUILD / HOTTEST BUILD. A shared
  `isUnclassifiedBuild` predicate (`apps/web/lib/unclassifiedBuilds.ts`)
  now gates all four surfaces; recent-form falls back to the matchup
  record and the other cards pick the best real build instead.
  Aggregation tables (Builds tab, Stock Market, meta radar
  distributions) intentionally keep showing catch-all rows — their
  share of games is a factual slice of the corpus; only surfaces that
  *recommend* a build exclude them.

- **"Nobody called it" can no longer get stuck on stream** — the
  Crystal Ball settle reveal's 12-second auto-dismiss timer was
  cancelled whenever another engagement event (a level-up from the
  same game's XP, a clip moment) landed mid-reveal, leaving the card
  up indefinitely until the next game. The timer is now keyed on the
  reveal itself and always fires on schedule.

### Added

- **Map replayer: fog of war, real mineral lines, and builders** —
  the replayer now draws the map's actual resource nodes (mineral
  patches, gold, geysers, destructible rocks, Xel'Naga towers)
  extracted from each replay (**agent 0.15.2**, playback payload v2),
  snaps mining workers to their real patches (3 workers per tapped
  geyser), clears mined-out lines and broken rocks at the recorded
  moment, shows the constructing worker at new building sites (SCVs
  stay the whole build, probes warp and leave), and renders
  fog of war — the union of both players' vision as soft reveals
  around every unit and standing building, leaving unscouted map
  dark. Older uploads keep the arc-based worker presentation until
  re-synced.
- **Map replayer (vespene.gg-style)** — watch any game back on its
  actual map: the real top-down layout render draws under the action
  (`/v1/map-image?variant=layout`, from the same artwork library the
  map thumbnails ship from), unit movements interpolate along their
  real replay tracks, buildings appear as they're placed with their
  in-game icons framed in each side's color, units render with their
  in-game icons too (workers dimmed and smaller), plus battle pulses,
  spawn markers, a scrubbable timeline with 1×–16× playback, and a
  live per-side HUD (army value · workers · supply). Stacked armies
  render with deterministic sunflower cluster-spreading so a 20-unit
  ball reads as a tidy blob of distinguishable icons instead of one
  pixel; maps without a layout render fall back to the flat
  background, and names without a shipped icon fall back to the
  original dot/square markers. Every ladder map since season 36 ships
  a layout render (the sync script's `--layouts` mode imports the
  uncropped originals recorded in the artwork manifest), so the real
  map shows for the whole current pool. Unit tracks pin to the
  replay's true position data — the 15-second combat snapshots and
  exact death coordinates the old extractor dropped (**agent 0.15.1**;
  games synced by older agents keep their old tracks until re-synced).
  Lives on each game's analysis page and inside the macro
  breakdown drilldown. The desktop agent now uploads a compact
  playback payload with each replay (bounded unit tracks, ~1 MB
  worst case, stored in the per-game detail store); games synced by
  older agents show a one-line re-sync hint instead of an empty
  canvas. Ships with **agent 0.15.0** (`agent-v0.15.0`) — see
  `apps/agent/CHANGELOG.md` for the agent-side details.
- **Twitch chat bot — the commands answer IN chat now** — connect a
  bot account (username + chat OAuth token, stored server-side and
  never echoed back) in Settings → Overlay → Multi-platform chat and
  it replies to !rank/!level/!xp (race-themed ranks), !mmr, !opponent
  and !build right in Twitch chat, counts !win/!loss calls and chat
  XP even when no dock or overlay chat source is open (deduped
  against browser reporting), and announces Crystal Ball opens,
  verdicts ("chat said 68% WIN — chat was RIGHT!") and level-ups,
  each toggleable. Rate-limited, per-command cooldowns, auto-
  reconnect with backoff, and a live status line in Settings.
- **Clip pipeline: from log to highlight reel** — the dock's clip
  moments now speak VOD: mark your stream start with one tap (or let
  Go live off Starting Soon auto-mark it) and every moment also
  shows its offset into the stream ("2:12:10 in"); paste the VOD URL
  after stream and each moment becomes a clickable deep link that
  opens Twitch (`?t=2h12m10s`) or YouTube (`?t=7930s`) at that
  second; "Copy timestamps" exports the whole list as
  `H:MM:SS — reason` lines ready for YouTube chapters or an editor's
  marker import.
- **Ghost Coach voice** — the Ghost Build widget can now SPEAK each
  armed step ~5 seconds before its target time ("16 — Gateway"), so
  you keep your eyes on the game instead of the HUD. Toggle "Voice
  coach" next to the Ghost URL in Settings → Overlay (bakes
  `voice=1` into the copied URL); a mid-game Browser Source
  reconnect resumes at "what should I do now" instead of narrating
  the backlog.
- **Landing page: new-feature showcase** — live animated demo frames
  for the chat bot conversation, the scrolling stats ticker, the
  Crystal Ball voting window, and the clip log with VOD links, plus
  refreshed copy; the editorial folios now run A→D in reading order.

- **Stats ticker · career facts, opponent intel, and oracle recaps**
  — the scrolling bottom line now draws from the player's entire
  history, not just the live session:
  - *Fun-facts pool* (server-computed from real games, rotated a
    page per loop so every pass reads differently): career record,
    total in-game hours, tracking-since, region-aware peak MMR and
    30-day MMR, longest win streak ever, career matchup split,
    most-played and best maps, longest game / fastest win, average
    game length, rush-defense and macro-game win rates, most-faced
    opponent, nemesis and favorite victim, unique opponents,
    barcodes faced, average opponent MMR, signature and hottest
    builds, APM average/peak, macro score, career units
    produced/killed/lost, structures flattened, time spent supply
    blocked (race-themed: "build more pylons"), favorite unit, recent
    form, this-week summary, best day of the week, milestone
    watches (win #1,500 in sight), on-this-day history, skill-
    fingerprint playstyle, ladder-season countdown, and first
    tracked game. Every fact has a minimum sample size — a new
    account gets fewer facts, never filler.
  - *Current-opponent intel* (live, in-game via the agent envelope):
    NOW PLAYING with opponent MMR, head-to-head, rival alert,
    rematch revenge line, MMR gap (upset material / protect the
    rating), cheese watch, scouted favorite opening, best-answer
    build, revealed barcode identity, predicted strategy.
  - *Crystal Ball on the ticker*: the open call with the live chat
    split, the last settled call ("chat said 68% WIN — chat was
    RIGHT"), and chat's collective oracle record.

### Changed

- **Crystal Ball voting now locks ~a minute into the game** — picks
  arriving after the lock are ignored server-side (no calling it
  after the game becomes readable), the on-stream CALL IT prompt
  (oracle widget + ticker) comes down at the lock, and the reveal
  still plays when the replay-verified result lands. Windows opened
  before this shipped lock off their open time, and an abandoned
  window (game result never arrived) stops being shown after a few
  hours — the prompt can never sit on stream forever.
- **Stats ticker scrolls at a constant reading speed** — pacing now
  derives from the measured strip width (~55 px/s) instead of the
  segment count, so the long career-fact sentences read at the same
  comfortable pace as the short live segments instead of racing.

### Fixed

- **No more "Victory — -35 MMR swing"** — replay files store the
  rating at game START, so the per-game MMR delta actually measured
  the previous game's outcome and could contradict the verified
  result on the lower third and the clip-moment log. A delta whose
  sign disagrees with the result (a win can never lose rating) is
  now suppressed everywhere instead of shown wrong.
- **Crystal Ball hands off instantly between games** — the 12-second
  settle reveal ("chat was RIGHT" / "nobody called it") no longer
  blocks the next game's CALL IT window: a new prediction opening
  clears the reveal immediately, and a live open window always
  outranks a leftover reveal even if the Browser Source re-mounted
  between games.
- **"Game Too Short" can no longer headline a build fact** — the
  classifier's sub-45-second catch-all bucket is excluded from the
  ticker's signature/hottest build stats (same exclusion the ladder
  meta uses), so cheese-heavy histories see their real builds.

- **Countdown timer widget** — a standalone on-stream countdown you
  can show at any time, set from the Stream Dock's new Timer panel:
  optional label ("next game in…"), minutes with 1/5/10/15 quick
  chips, live remaining time in the dock, and a pulsing "TIME!" at
  zero that stays until you clear it. Independent of the BRB /
  Starting Soon scenes. Includes a Settings Test button.
- **Stats ticker widget** — an always-on, continuously scrolling
  bottom line (ESPN style), distinct from the stationary post-game
  lower third: session record + net MMR, latest result, rank, stream
  goals, an open Crystal Ball call with the live chat split, top
  supporter and top oracle, looping seamlessly with a LIVE badge.
  Only real, currently-available data is shown; the source stays
  transparent otherwise. Reduced-motion renders it statically. Comes
  with the standard Settings Test button.

- **Settings · Help tab** — a full new-user guide: getting started in
  four steps, the analyzer, OBS overlay setup, multi-platform chat,
  the Stream Dock, viewer engagement (XP rules, predictions), and a
  troubleshooting section with support contact
  (responsecoaching@gmail.com).
- **Chat-commands card + "Copy for your bio"** — Settings now
  documents every viewer command (!win/!loss, !rank/!level/!xp,
  !1/!2/!3, !opponent/!mmr/!build) with one-tap copy of a
  bio-ready plain-text block, themed to the streamer's chosen
  loyalty rank race.

- **Stream Virality Pack** — five viewer-engagement features on a new
  cross-platform engagement layer (every chat surface reports what it
  sees; the server dedupes, so Twitch/Kick/YouTube/TikTok viewers
  share one system):
  - **Crystal Ball predictions** — chat calls `!win` / `!loss` while
    a game loads; the replay-verified result scores oracle points
    with an on-stream reveal ("Chat said 68% WIN — chat was RIGHT")
    and a season leaderboard.
  - **Loyalty XP + Supporter wall** — chatting anywhere earns XP
    through Protoss-themed ranks (Probe → Mothership); the wall widget
    rotates today's top supporters and toasts level-ups.
  - **Clip-moment detector** — chat spikes and notable game moments
    (big MMR swings, win streaks, marathon games) flash a "🔥 CLIP
    THAT!" pulse on stream and log a timestamped shortlist (with the
    chat lines that caused it) in the Stream Dock.
  - **Broadcast lower third** — an esports-caster bar that slides in
    after each game: result, MMR delta, opponent head-to-head,
    session record.
  - **Chat picks the build** — pick 2–3 saved builds in the dock
    (real win-rates shown); chat votes `!1`/`!2`/`!3` through the
    poll widget, and the close card shows the winner's win rate.
- **Landing page · Stream Studio showcase** — a new section with live
  animated previews of the merged chat, event alerts, stream goals,
  and the Starting Soon countdown, plus updated copy covering the
  full streaming toolkit.

- **Multichat · real-recording sound pack, custom sounds, and voice
  lines** — the alert/ding sound picker grows from 16 synthesized
  effects to 50+ options. A bundled pack of 35 real recordings
  (airhorn, metal pipe clang, sad trombone, record scratch, crickets,
  cha-ching, fart, goat, crowd applause/boo/laugh, screams, drum
  roll, buzzers, fanfares, thunder…) ships with the app — every clip
  sourced from free-commercial-use libraries (Mixkit, SoundBible
  CC BY), trimmed, mono-mixed and loudness-normalized; provenance in
  `public/sounds/multichat/CREDITS.md`. On top of that, add your own
  sounds three ways: paste a direct MP3 link (e.g. MyInstants),
  upload a small file (MP3/OGG/WAV ≤ 300 KB, served to OBS on your
  overlay token), or type a **voice line** spoken by the browser's
  speech engine. Custom sounds appear in every picker under "Your
  sounds" and can be mapped per event type.

- **BRB / Starting Soon scene widget + Stream Dock Scenes panel** — a
  full-screen animated scene source for OBS (drifting accent glows,
  floating embers, big letterspaced headline, huge ticking countdown
  that flips to a pulsing "STARTING NOW" at zero, optional custom
  message). Switch between Live / Starting Soon / BRB from the new
  Scenes panel in the Stream Dock, with quick 5/10/15-minute
  countdown chips — no OBS scene fiddling mid-stream. Has a Settings
  Test button like every widget.

- **Stream Dock · read highlights aloud** — a 🔊 Read-aloud button on
  the pinned highlight plus an "Auto-read new highlights" toggle:
  each newly pinned message is spoken on the dock's device, so you
  can hear the highlight while focused in-game.

- **Multichat · sound-effect library for alerts and the chat ding** —
  16 synthesized effects across four moods (Classic: ding, pop,
  doorbell · Cool: sparkle, laser, power-up, riser, boom · Arcade &
  meme: coin, victory fanfare, airhorn, bass drop · Funny: sad
  trombone, boing, slide whistle, drumroll). Everything is generated
  with WebAudio at play time — no audio files, works fully offline in
  the OBS Browser Source. Pick a sound for the chat message ding, and
  per-event alert sounds for the Event alerts widget (subs → victory
  fanfare, raids → airhorn, Super Chats → coin by default; every
  event type remappable or silenced), each with its own volume and
  preview buttons in Settings.

- **Settings → Overlay · Test buttons for the Stream Studio widgets**
  — Chat highlight, Chat poll, Event alerts, Stream goals and Session
  recap now have the standard Test button. Each fire renders
  clearly-labelled sample content in OBS for the usual ~20 s window
  (the poll steps through an animated demo tally, the alerts toaster
  plays a sub/raid/Super Chat/gift sequence, the recap card shows the
  sample session numbers), so streamers can place and style the
  sources without live Stream Dock state. Stop dismisses early, same
  as every other widget.

- **Stream Studio · dock, five new widgets, events, emotes, chat
  commands, translation** — the multichat family grows into a full
  streaming toolkit. A new **Stream Dock** (`/dock/<token>`, add it as
  an OBS custom browser dock or open it on a second screen) shows the
  merged live chat with one-tap **Highlight** (pins a message on
  stream) and two-tap **Block**, runs **chat polls** (viewers vote
  with `!1` / `!2` across all four platforms; live tallies, close and
  clear), edits **stream goals**, and fires the **session recap**
  card. Five new opt-in overlay widgets render it all: Chat highlight,
  Chat poll, Event alerts (subs, resubs, gift subs, raids, YouTube
  memberships and Super Chats, TikTok gifts/follows — parsed from the
  same anonymous transports, no extra logins), Stream goals (animated
  progress bars), and Session recap. The chat feed itself now renders
  real **Twitch and Kick emote images** (toggleable), answers
  `!opponent` / `!mmr` / `!build` from ANY platform's chat with an
  on-stream card, supports optional **inline translation** — free
  built-in on-device mode by default (an open-source OPUS-MT model
  runs inside the Browser Source, downloaded once and cached; chat
  text never leaves the OBS machine), with a custom
  LibreTranslate-compatible provider as an advanced option (key stays
  server-side) — and gains a **BRB scene mode** (`?mode=brb`).
  Highlight/poll/goal changes reach every Browser Source instantly
  over the overlay socket and survive restarts (Mongo-persisted per
  token, strict-sanitized).


- **Multi-platform chat · appearance studio, Test fire, and TTS** —
  the multichat widget is now fully stylable from Settings with a
  pixel-honest live preview rendered by the same component OBS uses:
  font family/size/weight, text shadow, row density, three layouts
  (single line, name-above-message, bubbles), entry animations,
  newest-at-top or bottom, left/right alignment, username colour
  modes, platform chips / role badges / timestamp toggles, message
  count and auto-hide timers, background colour + transparency slider
  (checkerboard preview), corner radius and border, plus content
  filters (!command hiding, a known-bot list, and a custom user
  blocklist). The widget's Test button joins the standard overlay
  test system — it plays a clearly-labelled demo chat stream so the
  source can be placed and styled without live chat. New
  text-to-speech reads incoming chat aloud from the Browser Source:
  per-platform selection, voice picker with in-Settings preview,
  speed/volume/length controls, username reading, command skipping,
  URL/emote scrubbing, and a bounded queue that skips backlog instead
  of falling behind — with the same gesture-unlock persistence the
  scouting voice readout uses. An optional message ding (synthesized
  in the Browser Source, volume slider, burst-collapsed, preview
  button) chimes on new chat. Everything is stored server-side and
  reaches OBS within a minute, no Browser Source changes needed.

- **Multi-platform chat overlay · Twitch + Kick + YouTube + TikTok in
  one OBS source** — a new `multichat` overlay widget merges all four
  live chats into a single broadcast-ready feed with platform chips,
  author colours, and role glyphs. Setup is one Settings section:
  Twitch needs only the channel name (anonymous read-only IRC, no
  OAuth), Kick reads its public chatroom directly after a one-time
  chatroom-id detection (with a guided manual fallback when Kick's bot
  protection blocks the automatic lookup), YouTube needs just a handle
  — each stream's live chat is discovered automatically through a
  key-free cloud relay — and TikTok needs only the @username: **no
  stream key required**, and an offline TikTok simply idles with a
  status dot until the LIVE starts, never affecting the other
  platforms. Every connection self-heals with backoff, config changes
  land in OBS within a minute without touching the Browser Source, and
  per-platform status dots show exactly what's connected while setting
  up.

- **Daily Pulse · fresh dashboard intel every day** — the analyzer
  dashboard now opens with a rotating strip of insight cards derived
  entirely from your own replay corpus: yesterday's session recap with
  net MMR, live win-streak / bounce-back prompts, distance to your
  90-day MMR peak, weekly climb recaps, builds heating up or gathering
  dust, nemesis and rival ledgers, map edges, matchup momentum,
  career-milestone countdowns, on-this-day throwbacks, and macro
  trends. The mix is deterministic per (account, day) — the same strip
  on every device — and rotates on the local-day rollover without a
  refresh. Cards deep-link into the tab that owns the full story, the
  strip collapses persistently, and a brand-new account sees nothing
  rather than filler: no card is ever synthesised.

### Fixed

- **Session ±MMR no longer counts server switches** — the session
  net-MMR (overlay session widget, recap, lower third, stats ticker,
  `!mmr`) previously diffed the first and last rated game of the play
  session regardless of ladder, so switching servers mid-session
  (e.g. EU → NA) reported the difference between two independent
  ratings as a huge fake gain ("+400 MMR"). Net MMR is now computed
  within a single ladder: the region of the latest rated game (from
  each replay's toon handle), with the anchor re-set to the first game
  of the session on that region. Two guards back it up: games on a
  known different region — or region-less legacy rows when the
  current region is known — can never anchor the delta, and if the
  live SC2Pulse rating resolves on a different region than the
  anchor, the ± is suppressed rather than shown wrong. Win–loss and
  streaks still count every game played, whatever the server.

- **Stream Dock · deleting a goal now removes it from the stream
  immediately** — the ✕ button previously only removed the row from
  the dock's local form; the overlay kept showing the goal until
  "Save goals" was also tapped, and reopening the dock brought the
  goal back. ✕ now saves the deletion instantly. Also hardened the
  goals editor against a rare race where the dock's initial load
  landing at the same moment as the first edit could wipe that edit.

- **MMR progression · long histories no longer truncated** — the
  Trends chart now widens its bucket interval (day → week → month)
  when the matched range would overflow the response cap, the same
  guard the W-L timeseries uses. Previously a 365+-day history on the
  "day" bucket silently dropped its oldest buckets and under-reported
  the all-time peak/trough. The chart header now labels the interval
  the server actually used, and the peak/trough tiles read
  unambiguously ("last −37 vs peak").
- **MMR progression by build · trust + recency** — the per-build MMR
  chart now applies the same replay-provenance gate as the main MMR
  chart (quarantined legacy ratings can no longer reappear as
  flat-line artifacts), keeps the *newest* points when a build
  overflows the per-build cap instead of the oldest, and honours the
  opponent-MMR range drill-down filter that was previously clobbered
  by the plausibility window. Its x-axis also derives day keys and
  labels from the same timezone, fixing duplicate-label splits for
  non-UTC players.
- **Overlay MMR delta · no more cross-ladder swings** — the on-stream
  MMR delta widget only chains games on the same Battle.net account
  and ladder race with replay-verified ratings, matching the trends
  pipeline. Finishing a main-account game and then queueing on a
  lower-MMR smurf (or switching ladder race) no longer flashes a fake
  ±1000 swing on stream.

### Changed

- **Agent 0.14.2 · StarCraft II 5.0.16b balance data** — the optimizer now
  defaults to the July 16 hotfix, including the Protoss weapon and Gateway
  changes, Terran Command Center/Planetary Fortress costs, Ghost supply, and
  the corrected four-second transformations in the optimizer plus the
  recorded Gateway-to-Warp Gate morph timing in replay analysis. Composition
  views now keep paid/manual Gateways and Warp Gates distinct until a recorded
  transformation occurs.

### Added

- **Ghost Build Coach · nine matchup loadouts** — Settings now provides a
  responsive control center for all nine concrete race pairings (`PvP`
  through `ZvZ`). Completed-game build logs are saved into an exact-matchup
  local library, each slot can be assigned, replaced, or cleared independently,
  and the dedicated OBS URL carries the compact selected loadout in a
  client-only fragment so even nine full builds stay below hosting request
  limits. Existing single-build Ghost setups get an explicit exact-matchup
  migration instead of being discarded. The live coach selects only the current
  pairing; Random opponents pause Ghost for the entire game with a clear
  “No build order vs Random players” message.

- **Ladder Meta Radar · opponent MMR bands** — `/meta` can now switch
  between opponent League and opponent MMR while keeping matchup as a
  separate filter. MMR uses eleven 500-point, half-open bands from `<2000`
  through `6500+`; every League/MMR/matchup view has a canonical,
  server-rendered URL. Both axes use the same opener rankings,
  k-anonymity floors, prevalence, win rate, and week-over-week movement.
  MMR coverage is intentionally forward-only and may be sparse until enough
  recently enriched games accumulate; League remains the default.

### Fixed

- **Session widget MMR refreshes after each game** — replay `myMmr` remains
  the historical session-start anchor, while SC2Pulse's current rating now
  drives the displayed MMR even when a stored game value exists. Fresh game
  ingestion bypasses the five-minute Pulse cache once, shared across all
  connected overlay sockets, so the post-game event cannot reuse a pre-game
  rating; Pulse failures still fall back to the stored value.

- **Agent 0.14.0 · Ghost matchup selection survives Browser Source
  reloads** — live envelopes now include the streamer's directly observed
  race, and an explicit Random selection for either player is retained for
  the full `gameKey` even if SC2 later reports the spawned concrete race.
  Unknown and `?` race values remain unresolved instead of being mistaken
  for Random, so later valid observations can still select the correct 3×3
  matchup. Clan-tagged player names and SC2's truncated race forms are
  normalized, and cloud enrichment trusts the direct race even on late
  playerless snapshots.

- **Agent 0.13.9 · fresh games no longer wait behind history syncs or
  upload repeatedly** — newly finished replays use dedicated priority
  parse and upload lanes, while bounded history work keeps large re-syncs
  from monopolizing the pipeline. Pending reservations now survive through
  acknowledgement and retry, duplicate game IDs coalesce, and the desktop
  Queued count reflects real pending work.

- **Session MMR updates stay monotonic under concurrent uploads** — an
  older replay/profile snapshot can no longer finish after newer work and
  roll the current MMR backward. Capture timestamps now travel through
  ingestion and stale updates are rejected atomically.

- **Long Ghost Build Coach URLs stay inside Overlay Settings** — the
  generated source URL now wraps within a bounded, copyable field so its
  Copy and Test controls remain visible without forcing the page wider than
  the viewport.

- **Skill fingerprint now explains what it measures** — the Trends card
  shows plain-language definitions, raw values, unavailable-signal coverage,
  the exact reason for the current playstyle, and a collapsible reference for
  every label rule. The former “Ladder” spoke is now separate competitive
  context: MMR is spelled out as Matchmaking Rating, no longer distorts the
  profile shape, and no longer participates in playstyle classification. The
  radar now labels its 0-at-centre / 100-at-edge scale and explains that a
  three-signal profile forms a triangle rather than an overall grade.

- **Game analysis returns to the opponent you came from** — links opened
  from an opponent dossier carry the encoded opponent id through the replay
  route. The analysis page now says “Back to <opponent>,” and the dashboard
  restores that dossier after navigation or refresh instead of dropping the
  user at the top-level dashboard. Direct game URLs without source context
  retain the safe dashboard fallback.

- **Ghost Build Coach · Test targets only its dedicated overlay** — the
  per-widget sample registry did not recognize `ghost-build`, so clicking its
  Test button fell back to the full sample payload and lit every other widget
  while the coach source appeared absent. Ghost Build now receives a scoped
  placement probe, and Settings explicitly identifies it as a dedicated OBS
  Browser Source that must be copied again after arming a build.

- **Overlay widgets fire once per real match start** - the Windows
  autostart entry and a manual launch could run two full agents at the
  same time. Their independent live pollers assigned different keys to
  one SC2 match, repeatedly re-arming Build Randomizer and Scouting
  Tells while also duplicating backlog work. Agent 0.13.8 now enforces
  one main process per state directory and preserves an active match
  through brief SC2 localhost-API misses. The API also suppresses live
  fan-out when a second agent or network retry re-uploads the same
  freshly-created replay.

- **Daily Quests - MMR progress stays on one regional ladder account** -
  `End the day up` previously compared the day's first and last MMR
  across every replay, so an NA starting point and EU ending point (or
  two accounts in the same region) could falsely complete or block the
  quest. It now groups by the exact replay-authored `myToonHandle`,
  requires two rated games on one account, and completes when any one
  account ends above its own start. Handle-less ratings are excluded
  because their ladder cannot be identified safely; `Giant slayer`
  remains a same-replay player-versus-opponent MMR comparison.

- **Season Recap · live Season 67 boundaries replace a fabricated
  Season 68 rollover** — the local fallback advanced seasons every
  fixed 91 days, which invented a July 1 Season 68 boundary while
  Battle.net was still in Season 67. That mislabeled the recap and
  incorrectly excluded April–June games from every recap statistic.
  The recap now consumes the existing SC2Pulse-backed season catalog
  from `FiltersContext`; its offline/pre-fetch fallback stays on the
  last verified Season 67 until a real new boundary is known.

- **Season Recap · MMR journeys stay on their own ladder account** —
  the recap previously date-sorted every numeric `myMmr` into one
  global series, so an NA game at 5,400 followed by an EU game at
  5,220 rendered a fictitious `-180` season. It now groups by the
  replay-authored `myToonHandle`, renders one labeled journey per
  account (`NA 267727`, `EU 8780508`, and separate same-region
  smurfs), and applies its two-point floor independently per account.
  Summary and sharing copy report separate Battle.net accounts instead
  of adding or sequencing their deltas. Rows without an own-account
  handle are omitted because their MMR cannot be attributed safely.

- **MMR progression · historical resyncs no longer flatten every game
  to today's rating** — the game-ingest route used SC2Pulse's current
  regional MMR whenever a replay omitted `myMmr`. During a bulk resync
  that cached fallback stamped one identical value onto every old game
  in the region, so the chart faithfully drew flat 5,400/5,220 lines
  and could assign the same rating to multiple accounts. Ingest now
  accepts only game-time MMR extracted from the replay. Agent 0.13.8
  sends explicit `replay` / `unavailable` provenance, and an
  `unavailable` re-upload atomically removes a legacy synthetic value;
  resyncing once after the agent update repairs affected history
  without guessing which unmarked database rows were contaminated.
  SC2Pulse remains the current-MMR fallback for live/session widgets,
  where a current value is semantically correct.

- **Import progress · the "games uploaded" counter no longer runs
  backwards** — during a history backfill the dashboard's progress
  card visibly bounced up and down. Root cause was a counter
  regression across three layers whenever an agent restarted
  mid-backfill (which the 0.13.5 auto-update did): the restarted agent
  re-adopted its running job and re-reported absolute counters
  starting near zero, `reportProgress` wrote them with `$set` (so the
  stored count dropped, then climbed again), and the web hook merged
  socket deltas from any job id including stale ones. Fixed at all
  three: `services/import.js` now updates `completed`/`errors` with
  `$max` (monotonic high-water mark) and broadcasts the post-update
  authoritative numbers; the web `useImportStatus` hook drops
  cross-job events and clamps counters to their max; and `agentStart`
  hands an adopting agent its job's prior progress so the agent
  (0.13.6) seeds its counters and continues the count instead of
  restarting it.

- **Macro engine · chrono counter self-calibrates across SC2 patches** —
  the Mechanics card showed "0 / N chronos · 0%" for Protoss games on
  new game-data patches. Macro casts are classified by numeric
  ability link against a hardcoded per-build table
  (`core/event_extractor.py`), and every table shift Blizzard ships
  moves the chrono link and zeroes the counter until a new cutoff is
  hand-derived — the 722→723 (5.0.13→5.0.14) shift already required
  one such fix. `extract_macro_events` now detects the chrono link
  structurally when the table misses (zero chronos in a Protoss game,
  or a candidate link out-casting the table's chrono 3:1): chrono
  boost is the only Protoss ability repeatedly targeted at the
  caster's own buildings, and Battery Overcharge — the only other
  own-building-targeted cast — can exclusively hit Shield Batteries,
  which chrono never can. Pinned against the real build-96883
  reference replay under three simulated table shifts
  (`test_chrono_link_self_calibration.py`).

- **Game timeline · supply readout capped at the game's 200 ceiling** —
  the deep-dive timeline tooltip/readout showed values like
  "Supply 180/212". Raw tracker events keep counting `food_made` (and
  `food_used`) past 200 when a player overbuilds overlords/depots,
  but in-game supply never exceeds 200. `lib/gameTimeline.ts` now
  clamps both fields at ingestion so the chart line, tooltip, readout
  bar, and aria labels all agree with what the game displays.

- **Ladder Meta Radar · agent finally uploads the opponent's league** —
  the /meta page ("which openers actually win") showed "Not enough
  games yet" for every league and matchup regardless of corpus size.
  Root cause was on the agent side, not the API: the ladder-meta and
  league-percentile aggregations band the games corpus on
  `opponent.leagueId`, and `replay_pipeline` has always tried to stamp
  that field from `opp.league_id` — but the replay-engine's
  `PlayerInfo` never had a `league_id` field, so the `getattr`
  silently produced `None` for every replay and no upload ever
  carried a league (the pipeline test faked the opponent with a
  `SimpleNamespace(league_id=5)`, which is why it never caught this).
  With the field missing corpus-wide, every (league, matchup) bucket
  held zero games — permanently below the k-anonymity serve floors in
  `services/ladderMeta.js` / `services/leaguePercentiles.js`. The
  parser (replay-engine 1.5.1, agent 0.13.5) now extracts sc2reader's
  `highest_league` from replay initData and normalizes its enum
  (1=Bronze..7=GM, 0/8=unranked) onto the ladder enum everything else
  uses (0=Bronze..6=GM); the pipeline stamps it for ladder games only,
  since matchmaking is what makes the opponent's league a valid proxy
  for the game's bracket. Existing uploads backfill on resync (game
  upserts overwrite slim rows), then the nightly recompute fills the
  radar.

- **Agent auto-update · a tag push is now a complete release** — the
  installed agent's updater polls the API's `GET /v1/agent/version`,
  which only served rows manually POSTed to `/v1/agent/releases`; the
  website's download card, by contrast, reads the GitHub Releases feed
  directly. So cutting an `agent-v*` tag *looked* fully published (the
  site offered the new installer) while every installed agent silently
  stayed on the old build until someone remembered the manual curl —
  which is how the 0.13.3 building-death fix sat unshipped. The API now
  merges a second release source (`services/agentGithubReleases.js`):
  the newest eligible `agent-v*` GitHub release (semver-sorted,
  drafts/prereleases skipped, sha256 read from the `.sha256` sidecar,
  10-min cache with stale-on-error). `AgentVersionService.latest()`
  serves whichever source is newer; Mongo rows win ties so a manual
  publish can still override notes/minSupportedVersion. Disable with
  `AGENT_RELEASE_GITHUB_FALLBACK=off`; repo override via
  `AGENT_RELEASE_GITHUB_REPO`. Off under `NODE_ENV=test`.

- **Agent 0.13.3 · building-death pipeline actually released** — the
  two earlier fixes below (structure lifetimes on the upload payload,
  opponent-side mirror, explicit destroyed bit) landed in source after
  the 0.13.2 installer was built, and the agent version was never
  bumped — so no release carried them and installed agents kept
  uploading `macroBreakdown` payloads without `production_buildings` /
  `opp_production_buildings`. The Macro Breakdown Buildings roster
  therefore still fell back to cumulative build-order counts (the
  "BUILD ORDER" badge), and the panel's Recompute button couldn't help
  because the recompute runs on the same outdated installed agent.
  Bumped the agent to 0.13.3 so a release can be cut
  (`git tag agent-v0.13.3 && git push --tags`, then publish to the
  release feed); after the agent updates, affected games need a
  one-time Recompute (or agent Resync) to re-upload with lifetimes.

- **Macro breakdown · total building wipes now reach zero** — structure
  lifetime records now carry an explicit destroyed/survived result. This
  prevents the latest (or only) real death from being mistaken for the
  legacy game-end survivor timestamp, while older replay payloads retain
  their existing sentinel fallback in both the browser and scouting API.

- **Macro breakdown · destroyed buildings now come off BOTH rosters,
  including mid-construction kills** — the death-aware Buildings roster
  shipped earlier only worked when the stored game carried
  per-structure lifetimes, and in practice they were almost never
  there: the agent's `macroBreakdown` payload didn't include the
  extractor's `production_buildings` array at all, and the extractor
  never emitted an opponent-side mirror in the first place (opponent
  building lifetimes were tracked internally for kill attribution,
  then discarded). Both rosters therefore fell back to the cumulative
  build-order count, so killed sunkens/spines, spores, and cannons
  stayed on the count forever ("43 Spine Crawlers" late-game). Three
  fixes, one per layer:
  - the extractor (`core/event_extractor.py`) now materialises
    `opp_production_buildings` / `opp_bases` from the opponent
    lifetime tracker, mirroring the my-side arrays;
  - structures destroyed **or cancelled while still under
    construction** (a sniped warping cannon / morphing spine — they
    never fire `UnitDoneEvent`, so they previously produced no death
    record even though the build log counts their construction start)
    now yield a lifetime record too, on both sides. They're kept out
    of `bases` / `opp_bases` so inject/chrono/MULE expectation windows
    and phase detection are unaffected;
  - the agent (`replay_pipeline._compute_macro_breakdown`) now ships
    `production_buildings`, `opp_production_buildings`, `bases`, and
    `opp_bases` on every upload, and the API's game-record schema
    documents the new fields with size caps.
  The SPA's `deriveBuildingComposition` consumes those arrays and
  subtracts deaths whenever they are present. Existing uploads
  keep their cumulative fallback until re-uploaded (Recompute /
  Resync), after which both panels drop destroyed structures at the
  hovered time, exactly like the Units roster.

### Added

- **Replay rows now identify the Ghost Build workspace** — the icon-only
  arrow into a game's full analysis page is now a visible “Open game
  analysis” action. Desktop tables label the destination column, while
  mobile cards explain that the page contains the timeline, mechanics,
  build orders, and Ghost Build arming tools.

- **Genuinely distinct overlay frames** — overlay settings add five
  structural styles: Command Grid, Neon Arcade, Arena Broadcast, Void
  Nebula, and Terran Foundry. Each has its own geometry, accent-rail layout,
  texture, shadow, and typography; preset cards now preview those silhouettes
  instead of showing only a colour dot. Custom controls still override frame
  defaults, and the new allowlisted style token stays backward-compatible
  inside existing v1 OBS theme URLs.

- **Forward-only opponent-MMR enrichment** — a new API worker enriches
  recently ingested ladder games that are missing `opponent.mmr` from
  SC2Pulse's current, per-race 1v1 rating. It matches the race the
  opponent played, marks every lookup attempt so misses do not retry
  forever, and uses the shared Mongo advisory lock plus a 25-game
  per-tick cap on its 15-minute cadence. The default `createdAt`
  window is 14 days and is hard-capped at 30, deliberately leaving the
  historical corpus and all already-stored MMR values untouched. This
  makes current MMR an explicit approximation of game-time MMR; the
  downstream MMR-banded Ladder Meta Radar will start sparse and fill
  naturally as new games arrive.

- **Win rate by map by matchup** — the Maps tab gains a new section that
  cross-tabs each map against opponent race, so you can see (for example)
  that a map is strong PvZ but weak PvT rather than just its overall win
  rate. Backed by a new `/v1/maps/matchups` aggregation
  (`AggregationsService.mapMatchups`) that groups the filtered games by
  `(map, matchup)`; the UI groups the cells under each map header, honours
  the existing Min games picker per cell, and shows the map's full record
  in the header. Respects the same `map_pool` / `game_size` / race
  filters as the rest of the tab.

- **SC2Pulse "revealed" opponent names** — when a barcode (or otherwise
  anonymised) opponent is linked to a known pro/main on
  sc2pulse.nephest.com, that reveal now flows through to SC2 Tools. The
  SC2Pulse `proNickname` is captured off the `/group/team` member during
  the existing MMR pull (`PulseMmrService`) and persisted as
  `revealedName` on the opponents row. Because a reveal can land long
  after we first resolved an opponent's `pulseCharacterId` — which the
  id-backfill cron never re-touches — a dedicated re-check pass
  (`OpponentsService.backfillRevealedNames`, wired into the pulse
  backfill job) re-probes already-resolved rows on a throttled 24 h
  window and stores any reveal it finds. The revealed name is surfaced
  in three places: the Opponents tab + opponent profile (an "aka /
  revealed" chip next to the unreadable bars), the live Opponent overlay
  widget, and the Scouting widget (via `oppRevealedName` on the overlay
  payload). Opponents who aren't revealed are unaffected.

- **Macro tab rebuilt as the Macro Report** — the per-game inspector
  (which duplicated the macro-breakdown popover already reachable from
  every game row) is replaced by aggregate analytics the app had
  nowhere else: win rate by macro-score bucket ("does macro win you
  games?"), a leak ledger pricing every leak category in minerals with
  win-rate-with/without and an improving/worsening trend
  (current-vs-previous half of the filtered range), avg-score segments
  by matchup / game length / build with a flagged weak spot, and a
  "fix this first" focus card. Every row clicks through to the exact
  games behind the number (new `leak` / `macro_min` / `macro_max`
  games-list filters) and from there into the existing per-game
  breakdown. New `GET /v1/macro/report` endpoint
  (`MacroReportService`) reads only slim game rows — one aggregation
  round-trip, no synthesised data. The summary header (average score,
  coverage, backfill) is unchanged.

### Removed

- **Per-game APM/SPM chart** — removed app-wide (Macro tab and admin
  game detail). The curve it plotted counted command events only,
  i.e. effective APM, while the legend claimed APM; rather than
  relabel a redundant chart it's gone. The agent still uploads
  `apmCurve` payloads and the API still stores/serves them, so the
  chart can come back later without a data migration. The Resources
  over time and Chrono allocation charts remain on the admin game
  detail view.

### Fixed

- **Macro breakdown · Terran add-on icons** — the Unit & Building
  Roster's Buildings row rendered a two-letter text badge ("BA", "FA")
  for Terran add-on structures because the icon registry had no entry
  for their sc2reader names (`BarracksReactor`, `FactoryTechLab`,
  `StarportReactor`, …). Added dedicated `reactor.png` / `techlab.png`
  building icons and folded every `*Reactor` name onto the reactor icon
  and every `*TechLab` name onto the tech-lab icon (mirroring how the
  crawler and WarpGate variants already resolve). Each add-on chip now
  shows its actual image icon, with reactor vs tech lab kept visually
  distinct.
- **Macro breakdown · Buildings roster now removes destroyed
  structures** — the Unit & Building Roster's Buildings row counted
  every structure ever built (cumulative), so a 27-minute game showed
  inflated totals like "55 Pylons" / "38 Gateways" even after many had
  been destroyed. The roster now starts from that cumulative
  build-order count and subtracts each structure that was destroyed by
  the hovered time, read from the macro breakdown's
  `production_buildings` lifetimes (`born_time` / `died_time`) that the
  extractor already records. Survivors are detected via the
  game-end sentinel (every surviving structure shares the same
  `died_time`), so the fix is immune to small timebase drift and works
  on already-uploaded replays without a re-upload. Buildings that have
  no per-structure lifetime data (older payloads) fall back to the
  cumulative count and surface the same "build order" badge the Units
  row uses. The death-aware derivation (`deriveBuildingComposition`) is
  mirrored into the server-side scouting port so the opponent-profile
  per-phase Buildings counts drop destroyed structures too.
- **Strategy classifier · PvZ - Stargate into Robo no longer steals
  Glaives-first builds** — a Stargate opener that researched Resonating
  Glaives as the FIRST Twilight upgrade and only later added a Robotics
  Facility (Observer / Immortal support behind a Glaive Adept timing)
  was mis-labeled `PvZ - Stargate into Robo`. That rule fired purely on
  "Robo present + one Stargate unit" and was checked before
  `PvZ - Stargate into Glaives`, so a build whose Robo came AFTER the
  Twilight got pulled onto the Robo label even though Glaives was the
  defining tech choice. Added the `not glaive_first_off_twilight` guard
  the sibling Stargate rules (2/3 SG Phoenix, 2 SG Void Ray) already
  carry, so Glaives-first builds now fall through to
  `PvZ - Stargate into Glaives` while genuine Stargate-into-Robo builds
  (no Glaives-first signal) are unaffected. Fixed in both the canonical
  detector (`core/strategy_detector_pvz.py`) and the `detectors/user.py`
  mirror, with a regression test exercising both entry points.

- **"Share with community" now actually publishes** — the BuildEditor's
  "Share with community" toggle (shown when you "Save as new build" from
  a replay) and the build sheet's "Build is public" toggle stored a flag
  the server then ignored, so a build shared this way never reached the
  Community tab. `PUT /v1/custom-builds/:slug` now honours the flag:
  publishing on save when it's on, unpublishing when off, and mirroring
  the result onto the build's `isPublic` badge. Saving a build is never a
  side-effect publish — the toggle defaults off for new builds and only
  acts when you opt in. Re-publishing an edited build now **keeps its
  public URL and vote count** instead of minting a new slug and resetting
  votes to zero, and the published snapshot **strips private fields**
  (personal notes, source-replay id, internal ids) so the
  "personal notes stay private" promise holds. v3 builds also get a
  derived `PvT`-style matchup tag so they show up under the right
  community filter.
- **Publishing from the analyzer Builds tab works** — clicking a build
  row opened a dossier whose "Publish to community" posted the build's
  display name where the slug-keyed API expected a slug (always
  `build_not_found`), and whose "Save notes" hit a route that doesn't
  exist. The modal now resolves the saved custom build behind the label
  and reuses the same publish dialog and notes save as the Builds
  library; auto-classified labels with no saved definition get a clear
  "Save as new build first" explainer instead of a silent failure.
- **Build randomizer no longer re-spins at game end** — the overlay's
  build roulette is a game-START reveal but was firing a second time when
  a game finished. Its 26 s visibility timer unmounts the widget
  mid-match (resetting the in-component spin-dedupe ref); when the
  post-game `overlay:live` payload arrived after the replay parsed, both
  overlay clients re-showed every widget — remounting the randomizer —
  and `deriveSpinKey` still keyed off the lingering `match_ended`
  envelope (the socket only clears `liveGame` on idle/menu). The spin key
  now derives from the agent envelope only while the match phase is live
  (loading / started / in-progress), and neither overlay client re-shows
  the randomizer on a post-game payload carrying a result. Test fires and
  the agent-offline pre-game path still drive it.


### Migration notes

- **Ladder classification now spans all seasons (auto-reclassifies on
  deploy).** The ladder / non-ladder map filter was matching games only
  against the *current* ladder rotation, so any game played on a ladder
  map from a past season (since rotated out) was wrongly bucketed as
  "custom". The classifier now uses `ALL_LADDER_MAPS` — the full LotV
  1v1 + team ladder history (sourced from Liquipedia's Ladder Map
  Timeline) — unioned with the live current pool, baked into
  `util/isLadderMap.js` so it works even when Liquipedia is unreachable.
  Each game records the classifier version that stamped it
  (`isLadderMapV`); the startup backfill job reclassifies any game not
  at the current version (`LADDER_CLASSIFY_VERSION`) on the next deploy,
  then self-skips. So **no manual step is needed** — merging + deploying
  reclassifies existing history automatically (bump
  `LADDER_CLASSIFY_VERSION` whenever the map list changes to trigger a
  fresh pass). Disable the auto-pass with
  `SC2TOOLS_LADDER_BACKFILL_DISABLED=1`; the one-shot
  `node apps/api/src/db/migrations/2026-05-27-backfill-is-ladder-map.js`
  remains for a manual run.

  The map name is still a *proxy*, though — a custom game played on a
  ladder map would look like ladder. The agent (v0.10.0+) now emits an
  authoritative `isLadderGame` flag read from the replay's matchmaking
  category; ingest, the backfill job, and the migration all **prefer
  that flag** when present and fall back to the map-name proxy
  otherwise. So games re-ingested by the new agent (via a Resync)
  classify with 100% accuracy regardless of the map.

- **Ladder-map backfill.** The new ladder / non-ladder map filter
  `$match`es on a stored `isLadderMap` boolean that only fresh ingests
  carry. Two ways to classify pre-existing games (both match the stored
  map name against the live ladder pool, 1v1 + team — no replay
  re-upload needed):
  - **Automatic (default):** the API runs a guarded, idempotent
    backfill on startup (`jobs/ladderMapBackfillJob.js`). It only
    touches games missing the field, self-skips once the dataset is
    fully classified, never blocks boot, and refuses to write if the
    pool resolves empty. Disable with
    ``SC2TOOLS_LADDER_BACKFILL_DISABLED=1``.
  - **Manual one-shot:**
    ``node apps/api/src/db/migrations/2026-05-27-backfill-is-ladder-map.js``
    (``--dry-run`` / ``--batch=N`` / ``--user=ID``), e.g. via Render's
    Shell, for a controlled run or a re-classify after a pool rotation.
  Note: the sibling 1v1 / team filter relies on `playerCount`, which
  was never stored historically and CANNOT be backfilled — only games
  re-ingested by the v0.9.0+ agent (e.g. via a Resync) gain it.

- **Timebase rescale** (PR #309 + the 2026-05-17-rescale-timebase
  one-shot migration). After upgrading, run
  ``node apps/api/src/db/migrations/2026-05-17-rescale-timebase.js``
  to rescale your existing game data from the broken 16 fps sc2reader
  scale to the real LotV 22.4 fps scale the new agent emits. Without this, build-rule
  thresholds saved before the migration will not match games ingested
  after it (a "Stalker before 4:30" rule written against
  pre-migration buildLog text will be ~1.4× too late versus fresh
  ingests). The script snapshots each rewritten collection to
  ``<name>_timebase_pre`` before writing, stamps
  ``_timebaseScaledAt`` per doc so re-runs are no-ops, and drops the
  derived caches that regenerate on read. See the script header for
  ``--dry-run`` / ``--force`` / ``--user`` flags.

### Added

- **Per-race ladder MMR on the opponent deep-dive** — the opponent
  profile now shows an "MMR by race" table (current 1v1 MMR, season
  games, league per race) sourced live from SC2Pulse, instead of
  collapsing an opponent to a single number. Fixes the confusing case
  where a Protoss main who off-races Zerg surfaced only their (lower)
  most-recently-played Zerg MMR — the header pill now shows their
  highest-rated race. New `GET /v1/opponents/:pulseId/pulse-races`
  endpoint + `PulseMmrService.getRaceBreakdown`. The single stored MMR
  remains the fallback when SC2Pulse can't resolve the opponent.
  Per-race ratings are current-season and region-correct: candidates
  are filtered to the region whose current season was queried, so a
  colliding season battlenetId (CN's current season number equals an
  ancient NA/EU/KR season) can no longer surface a player's
  long-retired peak as their headline MMR. The table labels its
  "Season games" column (live current-season ladder count) and the
  opponents-list "Last MMR" column (rating from the most recent game
  vs them) so the data sources read clearly. SC2Pulse load is kept low:
  the breakdown is cached an hour per opponent (a ladder rating barely
  moves within one), and since a characterId lives in exactly one
  region the lookup is scoped to that region's current season — one
  SC2Pulse call per opponent instead of one per region (with identical
  season ids deduped for the unscoped/overlay path too).

- **Ladder-map and game-size filters in the global FilterBar** — two
  new segmented controls drive every analyzer tab (Opponents,
  Strategies, Trends, Maps, Builds) through the shared filter context:
  - **Maps · Ladder / Custom**: keep only games on the current SC2
    ladder map pool (1v1 and team ladder maps both count) or only games
    on non-pool (custom / arcade) maps. The API stamps an
    `isLadderMap` boolean on each game at ingest by matching the map
    name against the live Liquipedia-sourced pool
    (`LadderMapPoolService`); the FilterBar then `$match`es on it.
  - **Players · 1v1 / Team**: keep only two-player games or only team
    games (more than two players). Backed by a new `playerCount` the
    agent records per replay from the parsed player list.
  Both filters persist across reloads. Games uploaded before these
  fields shipped carry no classification and fall out of both buckets
  until re-uploaded.

- **Phase analytics rollout · build dossier, strategy drill-down,
  opponent profile, and pre-game scouting** — a single calibrated
  phase model (Early / Early-Mid / Mid / Mid-Late / Late) now drives
  four new surfaces, all backed by the same `phaseClassifier`
  service and the same trajectory + transition primitives:
  - **Phase trajectory + composition view on every build dossier**:
    `PhaseTrajectoryStrip` and `PhaseCompositionTabs` render inline
    on `/app → Builds` and `/builds/[slug]` for any custom build
    with ≥10 matched games. The strip shows the cohort's typical
    phase walk over time; the tabs break down unit composition,
    win rate, and final-phase distribution per phase bucket.
    Wired through the new `/v1/custom-builds/:slug/compositions`
    API route (`apps/api/src/services/buildCompositions.js`).
  - **Game transition Sankey (build → opp strategy → final phase
    → late comp)**: `BuildTransitionSankey` renders the four-stage
    flow on the same dossier. Backed by
    `/v1/custom-builds/:slug/transitions`
    (`apps/api/src/services/buildTransitions.js`); accessible
    `<table>` fallback for screen readers ships in the same
    component.
  - **Phase comparison in `StrategiesTabBuildVs`**: drill into a
    strategy with ≥5 matched games and the new
    `StrategyPhasePanel` + `BuildVsStrategyComparison` 2-col layout
    renders inline above the existing `StrategyMmrPanel`. Backed by
    `apps/api/src/services/strategyPhases.js`, with a snapshot test
    that pins the calibration.
  - **Opponent profile phase section**: recurring opponents on
    `/app → Opponents → [profile]` now show the same trajectory
    + Sankey pair, keyed on the opponent's perspective.
    Backed by `apps/api/src/services/opponents.js` phase routes
    and the `opponentsPhases.test.js` fixture suite.
  - **Phase-aware pre-game scouting widget**: the overlay widget's
    LAST GAMES rows are preserved verbatim; a new compact phase
    strip with the opponent's forecast phase trajectory now renders
    ALONGSIDE them. Triggered from `/settings/overlay` "Test
    widget" the same way the existing card is.

### Added

- **Strategy classifier · PvP Glaive Adept labels (0.8.8)**: PvP had
  no Glaive Adept classification, so two common builds were mis-tagged
  by the Blink-keyed rules — a Robo-first Glaive build (Robo →
  Twilight → Glaives) fell into `PvP - Rail's Blink Stalker (Robo
  1st)`, and a Twilight-first Glaive build that later picked up Blink
  fell into `PvP - Blink Stalker Style`. Adds **`PvP - Robo into
  Glaives`** (Robo before Twilight + Glaives is the first Twilight
  upgrade) above Rail's Blink Stalker, and **`PvP - Adept Glaives`**
  (Twilight is the first tech + Glaives first off it) above Blink
  Stalker Style. Order-based with no Gateway window (same principle as
  the PvZ / PvT Glaive rules); the generic `1/2 Gate Expand` opener
  labels fall through on a Glaives-first transition so the new labels
  are reachable. Mirror in `SC2Replay-Analyzer/detectors/user.py` in
  sync; two catalog entries in `data/build_definitions.json` AND
  `apps/web/lib/build-definitions/pvp.ts`. 8 new tests in
  `test_strategy_detector_pvp_glaives.py`; self-contained
  strategy-detector suite 135/135 passing.

### Fixed

- **Live overlay · opponent Pulse/MMR misses at game start (agent
  0.9.1)**: during a real game the overlay often showed no opponent MMR
  / Pulse profile even though the on-demand diagnostics "Retry" resolved
  the same opponent instantly. The paths resolve by different keys — the
  diagnostics/post-game paths key off the replay's toon handle
  (`region-realm-bnid`, exact) while the live game-start path only has
  the display name (Blizzard's local `/game` API exposes no toon handle
  or MMR mid-game), so it ran a fuzzy, region-blind name search. The
  agent now (a) forwards the streamer's own region to the live Pulse
  lookup (in 1v1 the opponent shares that server, so it disambiguates
  cross-region name collisions), (b) accepts the `NA` region label as an
  alias for SC2Pulse's `US`/code 1 so the hint actually applies, and
  (c) strips a leading clan tag (`[oM]Cure` → `Cure`) before the name
  search, mirroring the post-game pipeline. Pure barcodes still can't be
  resolved by name mid-game — only the post-game toon-handle path can —
  because the local SC2 API never exposes the opponent's toon handle.
  Tests: 4 new cases; live + bridge suites 36/36.
- **Admin + per-user opponent identity/MMR diagnostics** (cloud): new
  "Identity & MMR diagnostics" panel (admin drill-down + the user's own
  opponent deep-dive) explains why a Pulse ID shows `TOON` or an MMR
  shows `—`, with a Retry that forces a fresh SC2Pulse resolve + MMR
  refetch. Toon-only opponents now also attempt an MMR fetch by toon
  handle at ingest instead of being skipped. See PR #404.
- **Strategy classifier · PvZ - Stargate into Glaives is order-based
  (0.8.7)**: user-reported misclassification — a `Stargate → Twilight
  → Glaives-first → Blink-later` build (a Phoenix / Oracle into Glaive
  Adept timing with a heavy Gateway count) was labelled `PvZ -
  Standard Blink Macro` instead of `PvZ - Stargate into Glaives`. Root
  cause: the rule required `4 <= gate_count_6min <= 8`, so a real
  Glaive Adept timing (9+ Gateways for mass Adepts) failed the upper
  bound, skipped the Glaives label, and fell through to the Blink-macro
  rule once Blink was researched second on a 3rd base. The sibling
  `PvT - Stargate into Glaives` rule never had a Gateway window. Fix
  removes the window from `PvZ - Stargate into Glaives` so it
  classifies purely on ordering (Stargate before Twilight + Glaives is
  the FIRST upgrade off the Twilight, before Blink AND Charge). The
  `SC2Replay-Analyzer/detectors/user.py` mirror — which was further
  behind, using a loose Glaives-*exists* check plus an even tighter
  `<= 6` cap — was brought back in sync to use the same
  `glaive_first_off_twilight` signal. Catalog description refreshed in
  `data/build_definitions.json` AND
  `apps/web/lib/build-definitions/pvz.ts`. 2 new regression tests in
  `test_strategy_detector_pvz_adept_glaives.py` (heavy 9-Gateway and
  low-Gateway Glaives builds); self-contained strategy-detector suite
  127/127 passing.
- **Strategy classifier · PvZ - Stargate into Robo + PvZ - Stargate
  Opener (0.8.5 → 0.8.6 cosmetic rename)**: user-reported regression
  (Ruby Rock LE 2026-04-01 10:39:06) — a Stargate-FIRST opener that
  produced Phoenix and added a Robotics Facility for Immortal /
  Observer / Disruptor support was labelled `PvZ - 2 Stargate
  Phoenix`. The build was a classic Stargate-into-Robo transition
  that the PvZ tree had no dedicated label for, so the count-by-10:00
  signature of 2 SG Phoenix won by default. The PvT classifier
  already had `PvT - Phoenix into Robo` and `PvT - Stargate Opener` —
  they were never mirrored into PvZ. Fix adds three things: **(1)**
  `not has_building("RoboticsFacility", 600)` guard on the three
  pure-Phoenix / pure-VR Stargate-rush rules (2/3 SG Phoenix, 2 SG
  VR) — a Stargate opener that adds Robo is a hybrid and shouldn't
  claim the pure label. **(2)** New `PvZ - Stargate into Robo` label
  (PvZ counterpart of the PvT - Phoenix into Robo rule; renamed in
  PvZ to use the generic "Stargate into" phrasing because the rule
  accepts any Stargate unit — Phoenix / Oracle / Void Ray — not just
  Phoenix specifically) that fires for `stargate_first_tech + Robo +
  >=1 real Phoenix / Oracle / Void Ray by 10:00`. **(3)** New
  `PvZ - Stargate Opener` catch-all for any Stargate-first build that
  didn't match a more specific Stargate-prefixed rule (e.g. a
  Stargate that got harassed off mid-construction, or an unusual
  midgame composition without a named bucket) — previously these all
  fell through to `Macro Transition (Unclassified)`. Both new entries
  shipped in `data/build_definitions.json` AND
  `apps/web/lib/build-definitions/pvz.ts`. Mirror in
  `SC2Replay-Analyzer/detectors/user.py` in sync. 5 new regression
  tests in `test_strategy_detector_opener_guards.py` cover the
  reported case, Oracle / VR variants, the new catch-all, and a
  positive control (pure 2 SG Phoenix still matches). Full
  strategy-detector test suite: 142/142 passing. The 0.8.6 bump on
  top of 0.8.5 is purely the cosmetic rename of the new label
  ("Phoenix into Robo" → "Stargate into Robo") -- no behaviour
  change.
- **Strategy classifier · PvZ 2/3 SG Phoenix + 2 SG Void Ray refinements
  (0.8.4)**: two follow-ups to the 0.8.3 Stargate-opener guard,
  shipped together. **(1) Glaives-disqualifier on the Stargate-rush
  rules** — user-reported replay (Taito Citadel LE, 2026-05-25
  10:05:36) opened with Stargate FIRST (so the 0.8.3
  `stargate_first_tech` guard correctly passed it) but the player
  added a Twilight Council after the Stargate and researched Glaives
  first — a textbook Stargate-into-Glaives Adept timing with Phoenix
  as scouting / harass support. The 2 SG Phoenix rule still mis-fired
  because its count-by-10:00 signature ran BEFORE
  `Stargate into Glaives` and had no signal that distinguished pure
  Phoenix builds from Glaives builds with Phoenix support. Fix hoists
  `glaive_first_off_twilight` and adds
  `AND not glaive_first_off_twilight` to all three Phoenix-/VR-count
  Stargate-rush rules (2 SG Phoenix, 3 SG Phoenix, 2 SG Void Ray).
  Carrier / Tempest / AlphaStar intentionally NOT guarded — their
  Fleet Beacon + capital-ship window is too tight for a
  Glaives-into-capital-ship transition. **(2) Every opener guard in
  `detect_pvz` is now pure tech-ordering, no time thresholds** —
  user feedback: an opener is defined by what tech building was
  committed FIRST, period. Applied symmetrically across
  `stargate_first_tech` (was `sg_time < 360`), `twilight_first_tech`
  (was `twilight_time < 480`), DT Opener (was `dark_shrine_time <
  480`), Robo Opener (was `has_building("RoboticsFacility", 420)`),
  and Stargate-into-Glaives (was `sg_time < 420`). The time
  thresholds were double-counting — tech-ordering already excludes
  transitions, so the only thing the time clauses ever excluded was
  slow-but-pure openers (which then fell through to "Macro Transition
  (Unclassified)"). Downstream constraints (gate count, unit count,
  upgrade research, base count) already filter inappropriate matches.
  Catalog prose for all six Stargate-rush rules + DT Opener + Robo
  Opener + Stargate-into-Glaives + Adept Glaives (Robo) + Adept
  Glaives (No Robo) updated to drop the "(built before X:00 ...)"
  / "by 9:00" qualifiers (the Adept Glaives rules actually use the
  `gate_count_6min` window, so the "Gateways by 9:00" wording was
  always stale). Updates applied to both the Python catalog
  (`data/build_definitions.json`) and the TS catalog that powers
  the `/definitions` page (`apps/web/lib/build-definitions/pvz.ts`).
  Mirror in `SC2Replay-Analyzer/detectors/user.py` in sync. 7 new regression
  tests in `test_strategy_detector_opener_guards.py` cover both
  refinements plus positive controls (slow Stargate, slow DT, slow
  Robo, slow Twilight Glaives all classify correctly; pure 2 SG
  Phoenix still matches; Stargate-first-into-Blink still matches
  because Blink ≠ Glaives). Full strategy-detector test suite:
  137/137 passing.
- **Strategy classifier · PvZ Stargate-rush labels now require Stargate
  to be the FIRST tech building + new PvZ - DT Opener path + Zerg
  Nydus check runs before Muta Rush (0.8.3)**: three user-reported
  mis-classifications in the same session, all rooted in
  count-by-10:00 rules with no opener-ordering check.
  1. **PvZ - Carrier Rush, Tempest Rush, 2/3 Stargate Phoenix, 2
     Stargate Void Ray, AlphaStar Style** all fired on "Stargate + X
     by 10:00" with no guard that Stargate was the FIRST tech
     committed. A DT opener (Dark Shrine first) that transitioned
     into Carriers / Mothership in the midgame mis-fired as Carrier
     Rush; a Glaive Adept timing (Twilight first) that added 2
     Stargates around 7:00 to counter Lurkers mis-fired as 2 Stargate
     Phoenix. Every Stargate-rush rule in
     `core/strategy_detector_pvz.py` now requires
     `sg_time < 360 AND sg_time < twilight_time AND sg_time <
     dark_shrine_time AND sg_time < robo_time` so the label means
     what it says: Stargate was the first tech building. Mirror of
     the same OPENER-ordering principle applied across PvT in 0.8.1.
  2. **New `PvZ - DT Opener` label**: a clean DT opener (Dark Shrine
     first, real Dark Templar lands, no Warp Prism) had no home in
     the PvZ tree — the only DT-related rule was
     `PvZ - DT drop into Archon Drop` which requires a Warp Prism,
     so plain DT builds fell through to
     `PvZ - Macro Transition (Unclassified)` (or, before fix #1,
     mis-fired as Carrier Rush when they added Stargate tech
     later). New rule fires when `DarkShrine` is built before
     8:00 AND before any Stargate / Robotics Facility, with ≥1
     real Dark Templar by 9:00. Catalog entry shipped in
     `data/build_definitions.json` and
     `apps/web/lib/build-definitions/pvz.ts`; the public catalog
     count goes from 101 to 102 entries. Mirrored in
     `SC2Replay-Analyzer/detectors/user.py`.
  3. **Zerg opponent classifier · Nydus check now runs BEFORE the
     Muta-rush check in both Hatch-First and Pool-First branches.**
     The Muta rule fired on any Spire by 7:00 with `<45` drones; a
     Nydus opener that also added a Spire (late air follow-up,
     Brood Lord prep) mis-fired as 2 Base Muta Rush because the
     Muta check ran first and the Nydus check was dead code. The
     Pool-First branch had NO Nydus check at all — a Pool-First
     Nydus opener silently fell through to "Zerg - Pool First
     Opener", a macro-flavored catch-all that hid the all-in.
     Both branches in `core/strategy_detector_opponent.py` now
     check `NydusNetwork` first and the Pool-First branch has a
     real Nydus check. Mirrored in
     `SC2Replay-Analyzer/detectors/opponent.py`.

  9 new regression tests in
  `tests/core/test_strategy_detector_opener_guards.py` cover all
  three mis-classifications plus positive controls (true Carrier
  Rush / true 2 Stargate Phoenix / true Muta Rush still match) plus
  the clean DT Opener path plus catalog presence. All 128
  strategy-detector tests pass.
- **Strategies drill-down · build × strategy comparison now describes
  the same N games on both sides** (`#StrategiesTabBuildVs`). When the
  user clicked a cell in the build × strategy matrix, the resulting
  side-by-side trajectory used to compare incomparable populations: the
  left ("WHAT YOU TYPICALLY DO") column filtered the user's games by
  `myBuild === build` only, while the right ("WHAT THEY TYPICALLY DO")
  filtered by `opponent.strategy === strategy` only. For a player with
  a narrow build label but a broad opp-strategy bucket this produced
  wildly asymmetric counts (e.g. 15 games on the left vs. 503 on the
  right for `PvZ - AlphaStar Style (Oracle/Robo)` × `Zerg - 3 Base Macro
  (Hatch First)`) and the trajectories meant different things on each
  side. The drill-down now passes the OTHER axis through as a query
  parameter on all three endpoints
  (`/v1/custom-builds/:slug/compositions?strategy=…`,
  `/v1/builds/:name/phases?strategy=…`,
  `/v1/strategies/:name/phases?build=…`); both
  `StrategyPhasesService.evaluate` /
  `StrategyPhasesService.evaluateByBuildName` and
  `CustomBuildsService.evaluateBuildPhases` accept the cross-axis filter
  and restrict the matched set to the build × strategy intersection. The
  route-layer phase cache keys include the cross-axis suffix so
  unscoped (BuildDossier) and cell-scoped (drill-down) payloads for the
  same slug never alias. Header copy updated to reflect the new
  semantics. 5 new regression tests in
  `apps/api/__tests__/builds.test.js` +
  `apps/api/__tests__/customBuildsMatches.test.js`; existing
  `BuildVsStrategyComparison.test.tsx` assertions updated for the new
  query string.
- **Strategy classifier · every PvT OPENER label now requires
  its labelled tech to be the FIRST tech building (0.8.1 full
  sweep)**: same principle from the Robo First fix (0.8.0) and
  the Standard Charge Macro fix earlier in 0.8.1, now applied
  to every remaining PvT rule that names a specific opener.
  `Phoenix into Robo` and `Phoenix Opener` now require
  `sg_time < robo_time AND sg_time < twilight_time` (Stargate-
  first). `7 Gate Blink All-in`, `8 Gate Charge All-in`,
  `2 Base Templar (Reactive/Delayed 3rd)`, and `2 Gate Blink
  (Fast 3rd Nexus)` now require `twilight_time < robo_time AND
  twilight_time < sg_time` (Twilight-first). Without these
  guards a Robo-first opener that ADDED a Stargate / Twilight /
  TA later in the midgame would mis-fire the named label and
  steal the replay from the Robo First branch. Catalog prose
  for all six rules updated. Mirror in
  `SC2Replay-Analyzer/detectors/user.py` in sync. 7 new
  regression tests (one per affected rule + a positive case)
  in `test_strategy_detector_pvt_gateway_opener_variants.py`.
- **Strategy classifier · `PvT - Standard Charge Macro` now also
  requires Twilight to be the FIRST tech building (0.8.1
  follow-up to the 0.8.0 fix below)**: 0.8.0 replaced the strict
  `not has_building("Stargate", 9999)` guard with
  `twilight_time < sg_time` so Twilight-opener Charge macros
  with a midgame Stargate transition would classify here. But
  that check is trivially satisfied by any build that researched
  Charge with no Stargate exists earlier — including Robo-first
  openers that add a Twilight Council later for Charge support
  on 3 bases. So a Robo-first opener with a later Twilight + Charge
  was mis-firing Standard Charge Macro before the Robo First branch
  below could claim it. The fix adds the missing
  `twilight_time < robo_time` ordering check, mirroring the
  symmetric Robo First rule which has BOTH `robo_time < sg_time`
  AND `robo_time < twilight_time`. Standard Charge Macro now means
  what the label says: Twilight is the FIRST tech building (before
  both Robo and Stargate). Robo-first openers correctly fall
  through to Robo First. Mirrored in
  `SC2Replay-Analyzer/detectors/user.py`. Catalog prose updated.
  Regression test
  `test_robo_first_opener_with_later_twilight_and_charge_is_robo_first_not_standard_charge_macro`
  pins the Tourmaline LE shape — Robo at 2:43, Twilight at 6:00,
  Charge at 7:00, 3rd Nexus at 7:30, no Stargate.
- **Strategy classifier · `PvT - Standard Charge Macro` now
  describes the OPENER, not the entire composition**: same
  anti-pattern as the Robo First fix below — Standard Charge
  Macro carried `not has_building("Stargate", 9999)` which
  excluded any Twilight-opener Charge macro with a later Stargate
  tech-switch from the bucket. Found during the post-fix audit
  for "ever" guards across PvT / PvZ / PvP / opponent rules.
  The guard is replaced with `twilight_time < sg_time` so a
  Twilight-first 3-base Chargelot macro that adds a Stargate
  later in the midgame (Skytoss tech-switch, end-game Tempests,
  late Phoenix harass) still classifies as Standard Charge
  Macro. Stargate-led openers remain correctly caught by
  Stargate-into-Charge earlier in the chain. Mirrored in
  `SC2Replay-Analyzer/detectors/user.py`. Catalog prose
  updated in three places. Regression test
  `test_standard_charge_macro_fires_with_twilight_opener_and_late_stargate`
  pins the new positive case; the existing
  Stargate-first-then-Charge test is renamed to
  `test_standard_charge_macro_does_not_fire_when_stargate_is_first_tech`
  and now asserts the build resolves to Stargate into Charge
  (the correct label for that ordering).
- **Strategy classifier · `PvT - Robo First` now describes the
  OPENER, not the entire composition**: the previous strict rule
  carried a `not has_building("Stargate", 9999)` guard that excluded
  any build with a Stargate at any point from the Robo First bucket
  (the 31c38df / "Robo+Sg hybrid" change). That produced false
  negatives on the natural case: a Robo-first opener that later
  transitions into Stargate tech in the midgame (Skytoss tech-switch,
  end-game Tempests, late Phoenix harass). User-reported example:
  Tourmaline LE 2026-05-20 16:48 replay opened Gateway → Cyber →
  Robo at 2:43 — textbook Robo First — but the midgame Stargate
  knocked it into `PvT - Macro Transition (Unclassified)`. Catch-all
  rules below (Phoenix into Robo / Stargate Opener) only fire on
  Stargate-led openers (Stargate before Robo), so Robo-first
  openers with later Stargate transitions had nowhere to land. The
  Robo First rule now keys solely on the opener:
  `Robo before Twilight Council AND Robo before any Stargate`,
  matching the user's mental model that "Robo First" describes
  what the player opened with — not what their full composition
  ends up looking like by minute 12. Catalog prose updated;
  regression tests added in
  `test_strategy_detector_pvt_stargate_variants.py` (the
  Robo+Stargate-hybrid case now asserts it IS Robo First) and
  `test_strategy_detector_pvt_gateway_opener_variants.py` (the
  Tourmaline LE replay shape). Mirrors the legacy
  `SC2Replay-Analyzer/detectors/user.py` behaviour, which never
  carried the strict guard. Supersedes the entry below under
  `### Changed` for the same rule.
- **Real-game-time timestamps everywhere** — all build-log and
  replay-event timestamps now reflect the real in-game clock.
  Previously every timestamp was emitted at sc2reader's hard-coded
  16fps scale (``Event.second = frame // 16``), which is 1.4× too
  high on LotV replays (the real frame-rate is 22.4 fps).
  Affects ``buildLog`` / ``oppBuildLog`` text lines, macroBreakdown
  ``time`` / ``born_time`` / ``died_time`` fields, ability-event
  timestamps, ``unit_timeline`` ticks, and APM-curve sample times.
  The fix lives in a new ``core/timebase.py`` utility that infers
  the true fps from ``replay.frames / replay.length.seconds`` (so
  legitimate HotS / WoL replays at the genuine 16 fps still resolve
  correctly) and falls back to LotV's 22.4 fps when the header is
  incomplete. Mirrored in both the SC2Replay-Analyzer and
  reveal-sc2-opponent-main extractor copies, and in the agent's APM
  curve fallback. Existing stored games will be migrated in a
  one-shot pass (see issue #308 / Prompt 15). PR #309.
- **Strategy classifier · Terran 1-base 1-1-1 was lumped into the
  composition fallback**: the opponent-side Terran detector treated
  the OrbitalCommand morph of the main Command Center as a "2nd
  base" event (along with PlanetaryFortress morphs), because
  `cc_events` flattened all three name variants into one sorted
  list. For a real 1-base 1-1-1 all-in (1 CC, OC morph at ~2:11,
  Factory in main, Starport in main, no expand for the whole game)
  this gave `second_cc_time ≈ 130 s`, which is BEFORE the
  Factory's start time — so the rule chain skipped
  `Terran - 1-1-1 One Base` and tried `Terran - 1-1-1 Standard`
  instead. With no Engineering Bay on the field by 7:30 the
  classifier then fell all the way through to the composition
  fallback (`Terran - Bio / Mech / Sky / Stargate Comp`),
  hiding the 1-base all-in inside a macro bucket. The detector now
  counts ONLY `name == "CommandCenter"` events when computing
  `second_cc_time`; OC / PF morphs emit under their own names and
  are correctly ignored as same-building events. Mirrored in the
  legacy SC2Replay-Analyzer copy.

### Changed

- **Strategy classifier · `PvT - Stargate into Charge / Glaives /
  Blink` now require Robo-AFTER-Twilight**: if a Robotics Facility
  (or anything that requires one — an Immortal / Robotics Bay) lands
  BEFORE the Twilight Council, the build committed to a Robo path
  and the Twilight-led label is the wrong call. Those replays were
  getting silently stolen from `PvT - Phoenix into Robo` because the
  Stargate-into-X rules sit above it in the chain. The three rules
  now skip on `robo_time < twilight_time || immortal_time <
  twilight_time || robobay_time < twilight_time` so Phoenix-into-Robo
  catches the replay correctly. Catalog prose updated.
- **Strategy classifier · `PvT - Robo First` and `PvT - Standard
  Charge Macro` now require NO Stargate**: a Stargate at any point
  in the build means the game is a Robo+Sg or Charge+Sg hybrid, not
  the canonical pure-Robo / pure-Gateway-macro opener. Both rules
  used to fire on hybrid replays that should have landed under
  Stargate-into-X / Phoenix-into-Robo / Stargate Opener instead.
  Catalog prose for both updated.
- **Strategy classifier · "Game Too Short" threshold raised 30 s →
  45 s**: replays that survived to 32-40 s usually still amount to
  one Pylon and a handful of starting workers — not enough to call
  a build order. The wider window captures more leavers / drops
  into the matchup-prefixed `Game Too Short` bucket and out of the
  `Macro Transition (Unclassified)` catch-all. The FilterBar
  tooltip and all 9 `<X>v<Y> - Game Too Short` catalog entries
  reflect the new threshold; the "Hide too-short games" toggle
  behaviour and persistence are unchanged.

### Added

- **Strategy classifier · "Game Too Short" bucket per matchup**: the
  desktop agent's strategy detector now emits a matchup-prefixed
  `<X>v<Y> - Game Too Short` label on BOTH `myBuild` and
  `opponent.strategy` for any replay that ended in under 45 seconds
  (no build order developed). Nine labels — `PvP`, `PvT`, `PvZ`,
  `TvP`, `TvT`, `TvZ`, `ZvP`, `ZvT`, `ZvZ` — ship in the catalog
  with prose on `/definitions`. The same string lands on both fields
  so the data view stays consistent and the cohort is filterable as
  one group instead of being absorbed by `Macro Transition
  (Unclassified)` or `Unclassified - <Race>`.
- **Analyzer · "Hide too-short games" toggle**: the global
  `FilterBar` now carries a checkbox that drops every
  `Game Too Short` bucket from the Opponents, Strategies, Trends,
  Maps, and Builds tabs in one shot. The toggle flips
  `exclude_too_short=true` on the shared filter context;
  `filtersToQuery` forwards it to the API and `gamesMatchStage`
  applies a negated `Game Too Short$` regex on whichever side
  (`myBuild` / `opponent.strategy`) the user hasn't already
  constrained. **Default on** so KPI strips / opponent profiles /
  aggregates aren't polluted by disconnects + insta-quits out of
  the box; the user's explicit opt-out persists in localStorage as
  a boolean so refreshes don't re-enable it.

- **Strategy classifier · eight new build labels** wired end-to-end
  through the desktop agent's `OpponentStrategyDetector` /
  `UserBuildDetector`, the `/definitions` catalog, the analyzer
  drill-downs, and the stream overlay icon registries:
  - **`Terran - Proxy Starport Hellion Drop`** — sub-classifies the
    Yoon-style expanding proxy Starport + Hellion drop out of the
    generic `Terran - Proxy 1-1-1` bucket. Fires when a proxy
    Starport sits beside a 2nd Command Center and the FIRST Starport
    unit is a Medivac (the bus for the Hellions).
  - **`PvZ - Adept Glaives (No Robo)`** — Twilight Council is the
    FIRST tech building after the Cybernetics Core, Resonating
    Glaives is the FIRST upgrade out of Twilight, 4-8 Gateways by
    9:00, no Robotics Facility.
  - **`PvZ - Adept Glaives (Robo)`** — same opening signature +
    Robotics Facility for Observer / Immortal support.
  - **`PvZ - Stargate into Glaives`** (refined) — Stargate first
    tech, then Twilight Council, Glaives FIRST off Twilight (not
    Blink — that's Stargate into Blink). Gateway range widened to
    4-8 and the rule now strictly enforces upgrade order.
  - **`PvT - Stargate into Charge`** — Stargate before Twilight,
    Charge is the FIRST upgrade out of the Twilight Council. The
    Stargate unit produced does NOT matter.
  - **`PvT - Stargate into Glaives`** — same but Glaives first
    (the old-school Phoenix-into-Glaive-Adept midgame timing).
  - **`PvT - Stargate into Blink`** — same but Blink first.
  - **`PvT - Stargate Opener`** — catch-all: Stargate is the FIRST
    tech building after the Core and the build didn't match any
    more specific Stargate-prefixed PvT rule. Custom builds can
    refine from here.
  - **`TvP - 1-1-1 One Base`** — Terran user-side label: Barracks +
    Factory + Starport all built BEFORE the 2nd Command Center,
    none of the three is proxied. The classic 1-base 1-1-1 all-in
    vs Protoss (Cloak Banshee / Marine-Tank / Marine-Medivac-Tank
    pressure off a single base).

### Fixed

- **Strategy classifier · Glaive upgrade substring**: the
  `OpponentStrategyDetector` calls `has_upgrade_substr("Glaive", …)`
  to spot Adept Resonating Glaives, but `sc2reader` emits the raw
  `upgrade_type_name` as `AdeptPiercingAttack` — so
  `"Glaive" in "AdeptPiercingAttack"` was always `False` and the
  `Protoss - Glaive Adept Timing`, `PvZ - 7 Gate Glaive/Immortal
  All-in`, and old `PvZ - Stargate into Glaives` rules silently
  never fired on real replays. All three call sites now accept both
  `AdeptPiercing` and `Glaive` substrings, so these labels will
  start appearing in production once agents pick up `0.6.6`.

### Changed

- **Arcade · Bingo: Ladder Edition**: card overhaul. The per-map
  "Win on …" cells are gone; the candidate pool is now built from
  ~50 deduplicated objectives covering races, race + time combos
  (e.g. "Win as Zerg in under 8 min", "Win vs Terran in 20+ min"),
  win streaks (3 / 5 in a row), volume goals (play 10, win 10),
  macro thresholds (70+ / 80+ / 90+, plus "win with macro under 40"),
  APM thresholds, MMR matchups (close-mirror, +200 upset), build-name
  keyword matches against `myBuild` (Cannon Rush, Proxy, All-in, DT
  Rush, Reaper, …), opponent-strategy defends (cheese / proxy /
  all-in / rush), unit-built objectives (Mothership, Battlecruiser,
  Brood Lord, 20+ Marines, etc.) and "beat-the-X" mirrors. Race-
  specific candidates are gated on races the user has actually
  played in the last 30 days so cells stay winnable. Cards persisted
  under the previous schema auto-regenerate on load instead of
  waiting for the Monday rollover.

### Fixed

- **Arcade · Bingo: Ladder Edition**: cells were not ticking for
  satisfied objectives in production. Root cause was a pair of
  field-name mismatches in the resolver: predicates read
  `g.duration` / `g.macro_score`, but the raw Mongo rows use the
  canonical `durationSec` / `macroScore` (only the client-side
  `normaliseGame` lifts them to the legacy aliases). The resolver
  now reads both shapes, and `macro_above` is inclusive at the
  threshold (`>=`, not `>`), so a macro score of exactly 70 ticks
  the "Hit macro score 70+" cell.
- **Analyzer dashboard**: "Games today" no longer flips to 0 once UTC
  rolls past midnight in zones west of UTC. The card scopes its
  `/v1/timeseries` request to today's local-tz window via `since=`, so
  the server's day-bucket cap can't widen the response to weekly
  buckets that never match `todayKeyIn(tz)` on the client.
- **Win rate by game length**: bucket-summary cards no longer break the
  bucket label at the en-dash (e.g. `0–3m` wrapping to two lines with
  the win-rate percentage floating beside the first half). The header
  spans are now `whitespace-nowrap` with `flex-wrap`, and the 8-column
  dense layout is gated on `2xl` (≥1536px) instead of `xl`, so each
  card has comfortable room on standard desktop widths.
- **Stats ticker**: the all-time facts (peak MMR, biggest scalp,
  longest win streak, first tracked game) now date-stamp with the
  year — "PEAK MMR: 5,842 on NA (Dec 29, 2024)" instead of a bare
  "(Dec 29)" that left viewers (and the streamer) guessing which
  year a record from a previous year was set in.
- **Historical dates carry their year everywhere**: the analyzer's
  time charts (matchup/mix over time, map trends, H2H match-by-match
  timeline, MMR progression by build) previously added `'YY` to axis
  ticks only when the data spanned multiple years, so a window that
  sat entirely in a past year showed bare "Dec 29"-style labels; the
  year now also appears whenever the plotted data ends in a year
  other than the current one. The H2H custom-range pill formats both
  endpoints with their year for the same reason.
- **Supporter wall / stats ticker**: the streamer no longer ranks on
  their own engagement boards. The broadcaster chats in their own
  channel and earned loyalty XP like any viewer, so an active
  streamer could headline their own "TOP SUPPORTER" ticker segment
  and supporter wall. The engagement service now resolves the
  configured channel/username per platform and excludes those
  identities from the wall and the oracle leaderboard (filtered at
  read time, so existing walls fix themselves immediately; `!rank`
  still answers the streamer's own stats).

## [agent-v0.5.13] - 2026-05-09

Released as `agent-v0.5.13` on GitHub. Installer:
`SC2ToolsAgent-Setup-0.5.13.exe`.

### Why the version jumps from 0.5.10 to 0.5.13

`agent-v0.5.11` and `agent-v0.5.12` were tagged but the corresponding
``__version__`` bump in ``apps/agent/sc2tools_agent/__init__.py``
never landed on ``main``. The installer filename derives from the tag
(workflow's "Resolve version" step) so the artifacts published as
0.5.11 / 0.5.12 had the right names — but the binaries inside still
reported themselves as 0.5.10 in heartbeats, crash reports, and the
updater's "what version am I on" check, putting users in a soft
update loop. v0.5.13 is the first release in this stream where the
on-disk ``__version__`` matches the tag, so the agent and the cloud
finally agree on the running version.

### Fixed (web + agent) — Active Army chart no longer renders a phantom
late-game opponent spike (PR #157, originally targeted at v0.5.11)

A streamer's Jagannatha LE PvZ replay (10/22/2020) showed the
opponent army line stay near zero for ~13 minutes and then jump
**vertically to ~9 200** in seconds — a number that didn't reflect
actual gameplay. Worker counts and the Unit & Building Roster also
disagreed with the chart's tooltip at the same hovered tick.

The chart's army value was being reconstructed in the SPA via a
fragile cascade (``unit_timeline`` → build-order cumulative +
timeline-derived deaths → ``(food_used - food_workers) * 50``
heuristic). When ``unit_timeline.opp`` was empty for late-game
samples the path fell through to the build-order cumulative count
WITHOUT applying any deaths, yielding the *total ever built* on the
opp side as the army number for that one sample.

Now:

  1. The agent emits ``army_value`` per ``PlayerStatsEvent`` row in
     ``stats_events`` / ``opp_stats_events`` (sc2reader's
     ``minerals_used_active_forces + vespene_used_active_forces``,
     the same number the in-game Army graph and sc2replaystats's
     Army Value chart use), with a ``*_used_current_army`` legacy
     fallback for older sc2reader builds.
  2. The SPA chart binds the army line to ``army_value`` directly.
     The build-order and food-supply paths that used to produce the
     spike are now hard-clamped to ``ARMY_FALLBACK_CAP`` (9 000) so
     neither can synthesise a vertical line.
  3. Tooltip and roster share a single ``SeriesPoint`` per hovered
     tick so they cannot disagree on army value, worker count, or
     alive composition.

### Fixed (extractor) — WarpGate warp-ins no longer dropped from the
roster (PR #159, originally targeted at v0.5.12)

A streamer's PvZ replay (Tourmaline LE, 2026-05-08) had 41 Adepts
warped in via WarpGate — every one was missing from the SPA's
"Unit & Building Roster" because ``extract_macro_events`` populated
``unit_lifetimes`` only on ``UnitBornEvent``. WarpGate-warped units
(Adept, Stalker, Sentry, Zealot, Templar) emit ``UnitInitEvent``
(warp-in start) + ``UnitDoneEvent`` (warp-in complete) and NEVER
fire ``UnitBornEvent``. The extractor now accepts EITHER event as
the canonical "alive" tick, deduped by uid so the rare case where
sc2reader fires both can't double-count.

Same PR fixed ``_clean_building_name`` corrupting ``"Zergling"`` to
``"ling"`` (the helper used a global ``raw_name.replace("Zerg", "")``;
"Zergling" literally starts with the substring "Zerg" so the prefix
was eaten mid-name). The corrupted name fell out of every downstream
lookup so opp's roster showed ``"li"``-fallback chips with zero
mineral contribution for every Zergling. The prefix-strip now
requires a CamelCase boundary — ``"Zergling"`` and ``"SprayZerg"``
preserved, legacy ``"ZergHatchery"`` still folds to ``"Hatchery"``.

### Fixed (extractor) — Overlords + Overseer + ability-cast cleanup
(PR #160)

Audit pass over 3 additional reference replays (PvT × 2, ZvP)
surfaced four more unit-tracking edge cases on top of the warp-in
work:

  1. **Overlords now count.** sc2reader's ``army_value`` includes
     Overlord supply cost, and so does sc2replaystats's Army Value
     chart. Pre-fix, ``Overlord`` was in ``SKIP_UNITS`` so the
     roster's Σ(unit_cost × count) drifted ~100/Overlord below the
     chart's army number for every Zerg game (~1 400 mineral+gas
     gap on the ZvP audit replay). Removing the skip makes the
     chart and the derived roster sum agree.
  2. **Overseer (and any morph-from-supply unit) now appears.**
     With Overlord tracked, the existing UnitTypeChange rename path
     handles Overlord → OverlordCocoon → Overseer automatically.
     A defence-in-depth ``elif`` was added that creates a fresh
     ``unit_lifetimes`` entry on a UnitTypeChange when the uid was
     never tracked AND the new name is army-relevant.
  3. **Ability/projectile names skipped.** Reaper KD8Charge,
     Sentry ForceField, Oracle StasisTrap, and Disruptor Phased
     Nova all fire ``UnitBornEvent`` with a player pid but have no
     meaningful cost-catalog entry. Added all four to ``SKIP_UNITS``.
  4. **Building stance forms can't leak through morph creation.**
     The ZvP audit caught ``SporeCrawlerUprooted`` showing up as a
     "unit" chip. The new morph-creation handler in the
     UnitTypeChange branch is now gated against ``lifetimes`` /
     ``opp_lifetimes`` membership AND against the ``Uprooted`` /
     ``Flying`` / ``Lowered`` suffix family.

### Re-import note

Previously-uploaded replays will keep using the on-disk
``unit_timeline`` until they're re-extracted. Re-import (or click
Recompute on the Macro Breakdown panel) for the full fix:

  - chart's army number switches from the derived cascade to
    sc2reader's authoritative ``army_value``;
  - roster picks up Adepts / other warp-in units;
  - opp Zerglings / Overseers / Overlords show with correct chips
    and cost contributions.

The SPA's clamped derived path means even on legacy uploads the
chart will not produce a 9 200-style vertical spike — the number
just stays an approximation.

Tag this commit as ``agent-v0.5.13`` after merge to trigger
``.github/workflows/agent-installer.yml`` and produce
``SC2ToolsAgent-Setup-0.5.13.exe``.

## [agent-v0.5.7] - 2026-05-08

Released as `agent-v0.5.7` on GitHub. Installer:
`SC2ToolsAgent-Setup-0.5.7.exe`.

### Added (agent) — date-range sync filter (Settings → "Sync date range")

Mirrors the website's filter bar (`apps/web/lib/datePresets.ts`) so
the agent only uploads replays played within a chosen window. Vital
for new installs on PCs with thousands of historical replays — a
streamer scoping the filter to "Current season" no longer grinds
through years of old games to hydrate today's stats.

Modes:

  * `All time` (default; matches v0.5.6 behaviour)
  * `Current season` — auto-anchored to the in-progress ladder
    season using the same approximation the web app uses
  * `Season N` — last six seasons exposed as quick picks
  * `Custom date range` — explicit since/until pickers

Two-stage gating in the watcher:

  1. **mtime pre-check** during the sweep walk. Files whose
     filesystem mtime is well outside the window are skipped
     without parsing — saves ~200ms per file × 12k replays during
     a backfill. A 7-day slack window absorbs OneDrive sync
     timestamps and the case where a user copies a backup of old
     replays into the watched folder (mtime gets the copy time).
  2. **Post-parse date check** against the authoritative
     `cloud_game.date_iso`. Catches the false positives mtime let
     through. Replays outside the window are recorded as
     `"filtered"` in `state.uploaded` so the next sweep skips them
     without re-parsing.

Changing the filter triggers a sweep + drops every `"filtered"`
entry from state so the previously-hidden replays get a fresh shot.
`"skipped"` (parse failure / AI / corrupt), `"rejected"` (server
schema rejection) and successful upload timestamps are NOT touched.

Tag this commit as `agent-v0.5.7` after merge to trigger
`.github/workflows/agent-installer.yml` and produce
`SC2ToolsAgent-Setup-0.5.7.exe`.

## [agent-v0.5.6] - 2026-05-07

Released as `agent-v0.5.6` on GitHub. Installer:
`SC2ToolsAgent-Setup-0.5.6.exe`.

### Added (agent + api) — sticky "last known MMR" anchored on the user profile

The cloud session widget now has a fourth fallback tier that survives
even a games-collection wipe. The agent pings
`POST /v1/me/last-mmr` on every successful upload that carries a
fresh streamer MMR; the cloud stores it on the user profile as
`lastKnownMmr` / `lastKnownMmrAt` / `lastKnownMmrRegion`, and
`GamesService.todaySession` reads it as a tier between `games_anytime`
and the SC2Pulse network calls. The new tier is cheaper than
SC2Pulse (one user-row read, no HTTP) and covers the case where the
streamer's whole game history pre-dates the v0.5.6 MMR-extraction
fix — they see a real number on the overlay immediately on the next
ranked replay parse, without waiting for a re-sync to backfill
`myMmr` across every old row.

The push is gate-kept on the GAME date so a backfill of older
replays can't reset the sticky MMR to a season-old rating; the
server further dedupes same-value writes to keep the Mongo write
rate flat during a 12k-replay re-sync. The route is narrow on
purpose — it accepts only `mmr` / `capturedAt` / `region`, never
the user-editable profile fields — so the agent can't accidentally
clobber what the streamer typed into Settings → Profile.

### Fixed (agent + api) — session-widget MMR really populates this time

The v0.5.5 patch claimed to fix the streamer's own MMR by preferring
`me.scaled_rating` over `me.mmr`, but `me` in `replay_pipeline.py` is a
`PlayerInfo` dataclass that surfaces only `mmr` (already prefers
`scaled_rating` then `mmr` from the raw sc2reader player via
`_get_player_mmr`). The added `getattr(me, "scaled_rating", None)` call
always returned `None` and the codepath fell through to the original
`me.mmr` — i.e. v0.5.5 was a behavioural no-op. Streamers kept seeing
`NA — MMR` on the overlay (per a user-reported screenshot at
`v0.5.5`, 18 lifetime games, 3 ranked today).

This release fixes the actual problem in three places:

- `apps/agent/sc2tools_agent/replay_pipeline.py` introduces
  `_resolve_my_mmr(ctx, me)`, a layered fallback that first reads the
  PlayerInfo wrapper, then falls back to walking `ctx.raw.players` and
  reading `scaled_rating` / `mmr` directly off the matching raw
  sc2reader player. This rescues the case where the analyzer silently
  fell back from `load_level=4` to 3 on a problematic replay and left
  `scaled_rating` unset on the wrapper. One INFO log line per parse
  (`my_mmr_resolved` / `my_mmr_unresolved`) documents which source
  supplied the value so a streamer can grep their agent log to see
  exactly why the overlay says `—`.

- `apps/api/src/services/pulseMmr.js` makes `_resolveCharacterIdFromToon`
  walk a list of `term=` candidates instead of giving up after the
  first miss. The bare toon handle (which SC2Pulse's `TOON_HANDLE`
  term type matches directly) is tried first, then the `starcraft2.com`
  profile URL (the current canonical Blizzard host), then the legacy
  `starcraft2.blizzard.com` URL. The response parser now also accepts
  `members[*].character`, `member.character`, and `character` shapes
  for the canonical id (older Pulse responses occasionally omit `id`
  and only ship `battlenetId`; that still keys the team scan fine).

- `apps/api/src/services/games.js` `todaySession` tags every resolution
  with a structured `mmrSource` (`games_today` / `games_window` /
  `games_anytime` / `pulse_pulseid` / `pulse_toon` / `unresolved`) and
  emits a single pino INFO line per resolve. An operator triaging a
  stuck overlay can now grep `session_mmr_resolved` to see which tier
  fired (or that nothing did).

Net effect: streamers who never set their Pulse ID in Settings get
their MMR back via the more permissive SC2Pulse `term=` fallback, AND
new replay uploads carry the streamer's `myMmr` correctly so the
cheaper games-row path fires first on the next session. Existing rows
stay `myMmr`-less until a re-sync (or a future backfill) — but the
SC2Pulse-by-toon fallback covers them in the meantime.

Tag this commit as `agent-v0.5.6` after merge to trigger
`.github/workflows/agent-installer.yml` and produce
`SC2ToolsAgent-Setup-0.5.6.exe`.

## [agent-v0.5.5] - 2026-05-07

Released as `agent-v0.5.5` on GitHub. Installer:
`SC2ToolsAgent-Setup-0.5.5.exe`.

### Fixed (agent) — streamer's own MMR now extracted from `scaled_rating`

A streamer running a 13k-replay resync reported `NA — MMR` on the
session widget despite agent v0.5.4 and a healthy backlog of ranked 1v1
games landing in the cloud DB. Opponent MMR rendered everywhere
correctly; only the streamer's own MMR was missing. Root cause was an
asymmetry in `replay_pipeline.py`: the opponent extractor walked both
`mmr` and `scaled_rating` on each `Player` (preferring the latter), but
the local-player extractor read only `me.mmr`. Blizzard populates the
profile/init-data block (where `mmr` lives) inconsistently for the
recorder of the replay — it's frequently `None` for the local player
even on ranked ladder games — while the tracker-events stream (where
`scaled_rating` lives) carries every player's displayed MMR
symmetrically. The result: every uploaded game shipped `myMmr=null`,
both Tier-1 (today's games) and Tier-2 (any historical game with
`myMmr`) fallbacks in the session resolver returned empty, and the
overlay sat on `— MMR` forever for any streamer who hadn't manually
pasted a Pulse ID into Settings → Profile.

Fix is symmetric with the opponent path: prefer `scaled_rating`, fall
back to `mmr` only if absent. New replays carry the streamer's MMR on
upload, and the session widget populates from Tier-1 immediately on
the first ranked game ingested after the agent upgrade. Existing rows
in the DB stay `myMmr`-less until a re-upload (or a future backfill).

## [agent-v0.5.4] - 2026-05-07

Released as `agent-v0.5.4` on GitHub. Installer:
`SC2ToolsAgent-Setup-0.5.4.exe`.

### Fixed (agent) — macro breakdown now ships even when the score engine fails

A streamer reported the macro card going blank ("Macro breakdown not
available") for a game that had clearly uploaded successfully. Root
cause: any exception inside `analytics.macro_score.compute_macro_score`
— a new race-specific leak rule, a divide-by-zero on a 30 s sub-game,
an edge case the engine hasn't seen yet — bailed `_compute_macro_breakdown`
entirely and returned `(None, None)`. The chart half of the breakdown
only needs `stats_events` + `unit_timeline`, both of which had already
been extracted successfully at that point, but the all-or-nothing
fail-soft sent zero data over the wire and the SPA had nothing to
render.

The fail-soft now degrades gracefully. When the score engine raises,
the agent logs `compute_macro_score_failed` at WARNING and ships a
partial payload: `raw={}`, `all_leaks=[]`, `top_3_leaks=[]`, but a
fully-populated `stats_events`, `opp_stats_events`, `unit_timeline`,
and `player_stats`. The Active Army & Workers chart and the unit
roster render unchanged; the headline score shows "—" rather than
nothing-at-all. Locks the SPA's render-blocking dependency on the
score-engine output.

### Fixed (web) — Active Army chart no longer dives to zero on sparse unit_timeline samples

A streamer's chart showed "you army" basically flat at 0 for the first
10 minutes of a 17-minute game, then a single spike at the end — even
though the in-game graph showed steady army value throughout. The unit
roster below the chart was death-aware and correct, so the divergence
came from the chart's series builder.

Two bugs in `compositionAt.ts` produced the dive:

1. ``derivedDeathsFromTimeline`` treated an empty per-side map at a
   sample tick as "every alive unit died this tick" and generated
   `cumulative-built` spurious deaths. When `unit_timeline` had legit
   data gaps (one sparse sample mid-game), the chart's death
   subtraction nuked the build-order cumulative count down to zero.
2. ``deriveUnitComposition`` short-circuited on a populated-but-empty
   timeline entry as if the player legitimately had no alive units —
   it preferred the timeline's "0 alive" reading even when the
   build-order cumulative said the player had clearly built units.

The fix makes both functions defensive against extractor gaps: a
populated→empty transition where *both* sides go empty in the same
step is treated as a data gap, not a wipe (real wipes leave the
opposing side's army intact). Genuine total wipes (one side empty,
opponent's army still on the field) still register as deaths.

### Fixed (agent + cloud) — overlay session widget MMR now resolves automatically via SC2Pulse

A streamer whose session-widget panel kept showing the bottom row as
``EU —`` (or ``NA —``) instead of their current ladder MMR fell into
a coverage gap between the existing fallback tiers:

1. ``games[].myMmr`` is the fastest path but `sc2reader` only fills it
   for ranked replays where the engine surfaces ``scaled_rating``.
   Streamers whose recent replays were uploaded before the v0.4.x MMR
   extraction landed had every cloud row missing the field.
2. Tier-3 (SC2Pulse) was added in v0.4.x but only fires when the user
   has typed a **numeric** SC2Pulse character id into Settings →
   Profile → Pulse ID. The hint ("Auto-detected by the agent on the
   first sync") is aspirational — the agent reads the field but never
   writes it. New users see "EU —" indefinitely.

The fix forwards the streamer's own raw `toon_handle` (e.g.
``"2-S2-1-267727"``) on each game upload — the agent already has it
from the parsed replay's ``me.handle``. The cloud's `todaySession`
aggregator tracks the most recent value across the 14-day window and,
when neither stored MMR nor the profile's `pulseId` resolved, calls a
new `PulseMmrService.getCurrentMmrByToon` that:

- Decodes the toon handle into the legacy battle.net profile URL
  (`https://starcraft2.blizzard.com/profile/<region>/<realm>/<id>`).
- Hits SC2Pulse's `/character/search?term=<url>` to map it to the
  canonical numeric character id.
- Forwards that id to the existing `getCurrentMmr` so the per-region
  team scan, 5-minute cache, and stale-while-error semantics all
  apply unchanged.

The toon→characterId mapping is cached process-wide so repeat session
ticks pay only the team scan, not another search round-trip. The
`getCurrentMmr` entry point also now accepts toon handles directly,
which rescues users who pasted their raw handle into Pulse ID instead
of the numeric id.

`gameRecord.js` validation accepts the new optional `myToonHandle`
field. Pre-cutover replays that lack the parser attribute still upload
fine — the field is optional both on the agent dataclass and the
cloud schema.

Tests: 5 new pulseMmr.test.js cases (toon-handle fallback, character
search response shapes, cache, garbage rejection), 4 new
overlaySession.test.js cases (toon-handle Tier-3 fires when pulseId is
unset, when pulseId fails to resolve, short-circuits when myMmr is
present, survives a thrown error), 2 new test_replay_pipeline.py cases
(payload includes/omits myToonHandle). All 390 API tests + 27 agent
replay-pipeline tests pass.

### Fixed (agent v0.5.3 + cloud) — Map Intel "Request resync" actually backfills heatmaps now

The Map Intel heatmap viewer's "Request resync" button on the website
appeared to do nothing for users with substantial replay history — they
saw "no spatial extracts on this map yet" indefinitely no matter how
many times they clicked it, even with the desktop agent online. The
modal showed counts like "239 games · 179W · 60L" with an empty
heatmap underneath; toggling between My proxies / Opp. proxies /
Battles / Death zones / Buildings layers showed the same empty state
on every layer.

Root cause: the cloud's resync flow was wired exclusively through the
``macro:recompute_request`` socket event. That event carries a list of
gameIds, and the agent translates each into a local replay path via
``state.path_by_game_id`` — a reverse index added in agent v0.4.0.
Anyone whose state file was written by an earlier agent had an empty
``path_by_game_id``, every gameId resolved to zero local files, and
the agent's ``make_recompute_handlers.on_macro`` callback silently
returned without queueing anything for re-upload. Meanwhile the web
UI cheerfully reported "Resync requested. If your desktop agent is
online, heatmap data will refresh shortly." — a message that was
simply never going to come true for those users.

The wiring fix is a dedicated ``resync:request`` socket event:

- The cloud now emits ``resync:request`` (in addition to
  ``macro:recompute_request``) whenever ``/v1/macro/backfill/start``
  is called with ``force: true``. A free-form ``reason`` string rides
  along for diagnostics. Targeted recomputes (``force`` omitted /
  false, used by per-game "Recompute now" buttons) still fire only
  the per-game event so a single missing macroBreakdown doesn't
  trigger a multi-thousand-replay walk.
- The agent's ``SocketClient`` subscribes to ``resync:request`` and
  invokes the same flow the GUI's "Re-sync" button does:
  ``state.uploaded`` is cleared, ``upload.request_full_resync()`` is
  called, and the watcher re-walks every replay folder. Each replay
  re-parses with the latest extractor — including
  ``_compute_spatial_extract`` — and re-uploads with
  ``spatial.{map_bounds, my_proxies, opp_proxies, buildings,
  battles, deaths}`` attached. SpatialService picks up the data on
  the next read and the heatmaps populate.
- ``make_recompute_handlers.on_macro`` also gained a belt-and-braces
  fallback: when a bulk request (≥ 5 gameIds) resolves to zero local
  paths, it triggers the same full-resync. This rescues any agent
  that misses the new event entirely (e.g. a fork or a stale build).

The web Map Intel viewer was polished in the same pass:

- Per-layer empty-state copy. Each of the five heatmap layers
  (proxies, opp proxies, battles, death zones, buildings) now shows
  guidance specific to what that layer measures, instead of a
  generic "play more games" line.
- Auto-revalidation after a resync: the viewer polls
  ``/v1/spatial/*`` on a 12 s cadence (capped at 12 ticks) so
  newly-uploaded extracts surface without a page reload, then stops
  the moment data lands.
- A manual ``Refresh`` button alongside ``Request resync`` for users
  who want to force a fetch.
- When spatial data is already present, the action button changes
  to ``Re-extract`` (ghost variant) so it doesn't read as redundant.
- Heatmap rendering polish: SVG ``mix-blend-mode: screen`` for
  warmer compositing on dark minimaps, opacity that scales with
  cell intensity, a vignette ring on the canvas, and stable
  per-layer gradient IDs (no more colour-hash collisions).
- Error-tone banner (red border + bg) for failed requests vs
  info-tone for success.

To apply this fix, users must update the desktop agent — auto-update
will deliver v0.5.3 within ~24 hours of release. After updating, click
"Request resync" on any Map Intel map (or the GUI's "Re-sync" button
directly) and the heatmaps will populate as the agent re-uploads each
replay. Users still on v0.5.2 or earlier won't see heatmaps populate
even after clicking "Request resync" because their agent doesn't
subscribe to the new event.

Tests: 6 new agent-side tests in ``test_socket_client.py`` lock down
the happy path, the single-gameId no-fallback policy, the bulk
fallback to full resync, the no-callable safety net, the explicit
``resync:request`` handler, and exception swallowing inside the
recompute callbacks. Two new API tests in ``perGameCompute.test.js``
verify ``force=true`` emits BOTH events with the reason field and
``force=false`` emits ONLY the per-game event.

### Fixed (agent v0.5.2) — Macro breakdown now uploads on every replay again

A regression introduced when the agent started pinning the macro
extractor to ``SC2Replay-Analyzer/`` (v0.5+ surface) caused every
recorded replay to ship without a ``macroBreakdown`` field. The SPA
fell through to the ``Macro breakdown not available for this game
yet`` empty state, so the macro card never populated for newly-uploaded
games and the dashboard's Macro column showed em-dashes.

Root cause: ``replay_pipeline._load_sc2ra_module`` honored a
``sys.modules[dotted_name]`` entry whenever one was present, intending
to support test stubs. But ``parse_replay_for_cloud`` calls
``from core.sc2_replay_parser import parse_deep`` BEFORE
``_compute_macro_breakdown``, and reveal-sc2-opponent-main's
``sc2_replay_parser`` runs ``from .event_extractor import …`` which
populates ``sys.modules['core.event_extractor']`` with reveal's older
copy. The reveal copy's signature is ``(replay, my_pid)`` — no
``opp_pid`` parameter — so the agent's three-arg call raised
``TypeError`` before any extraction ran. The exception was caught and
logged at WARNING (``extract_macro_events_my_failed: ...``), and
``_compute_macro_breakdown`` returned ``(None, None)``. Since the
warning is the only signal and the upload still succeeds without a
breakdown, the regression was invisible from the user's
side except for the empty macro card.

The fix adds ``_is_safe_cached_module`` to distinguish a deliberate
test stub (no ``__file__`` attribute) from the real reveal copy
(``__file__`` containing ``reveal-sc2-opponent-main``). The loader
now rejects reveal entries and falls through to disk load via
``importlib.util.spec_from_file_location`` against
``SC2Replay-Analyzer/``. Test stubs are still honored via the same
sys.modules path. Three regression tests lock the behavior down:
``test_load_sc2ra_module_skips_reveal_copy_pre_registered_in_sys_modules``,
``test_load_sc2ra_module_honors_test_stubs_without_file``, and
``test_load_sc2ra_module_uses_internal_cache_on_repeat_calls``.

To get the breakdown for replays uploaded under v0.5.0–v0.5.1, open
the agent app and click Resync. The agent will re-parse every replay
on disk and re-upload it, this time including the
``macroBreakdown``. Per-game ``Recompute now`` from the SPA also
works once the user is on v0.5.2.

### Added (cloud v0.5.0) — Trends tab gains four enrichment charts + Map Intel modal + start-time build-order display

The Trends tab previously answered exactly one question — "did I win
more this week than last week?" — and that's barely useful. This
release adds four new lenses on the same dataset, each backed by a
single-pipeline aggregation so the cost stays linear in the user's
own history:

- **Win-rate by matchup over time.** Small-multiples chart with one
  panel per opponent race (P / T / Z / R), 50% reference baseline,
  bucketed at the user's chosen day / week / month interval. Powered
  by ``GET /v1/timeseries/matchups``.
- **Performance by time of day.** 7×6 day-of-week × 4-hour-block
  heatmap with WR / Volume colour modes. Times are in the user's
  IANA timezone. Powered by ``GET /v1/timeseries/day-hour``.
- **Win rate by game length.** Composed bar+line chart with
  ``<8m / 8–15m / 15–25m / 25m+`` buckets and a 50% reference line,
  plus per-bucket summary tiles below. Powered by
  ``GET /v1/length-buckets``.
- **Activity calendar.** GitHub-style contribution graph; cell hue
  carries win rate, saturation carries games-played. Doubles as a
  consistency indicator. Powered by ``GET /v1/activity-calendar``.

Implementations live in
``apps/api/src/services/trendsAggregations.js`` so
``aggregations.js`` stays under the per-file size budget. The four
new chart components live under
``apps/web/components/analyzer/charts/``; the Trends tab now renders
on a 2-column grid (single column on mobile) with the matchup
small-multiples and activity calendar spanning both columns.

### Changed — Map Intel viewer renders inside a modal

Selecting a map in the Map Intel tab used to mount the heatmap
viewer inline at the bottom of the page, which on mobile pushed it
below the table out of view (looked like clicking did nothing).
The viewer now opens in the existing portal-based ``Modal`` so it
overlays the page on every breakpoint. ``MapIntelViewer`` gained an
``embedded`` prop that drops the outer Card chrome when a parent
already provides it.

### Changed — Build-order timelines display construction-START times

Players reason about openings in start-time terms ("I started Cyber
at 1:50") but sc2reader records different events at different points
in construction:

- Protoss/Terran structures (UnitInitEvent) — already at the
  construction-start moment.
- Zerg structures (UnitBornEvent on drone consumption) — already at
  start.
- Structure morphs (Lair / Hive / OrbitalCommand / WarpGate /
  GreaterSpire / PlanetaryFortress, via UnitTypeChangeEvent) —
  recorded at FINISH.
- Units (UnitBornEvent at emergence) — recorded at FINISH.
- Upgrades (UpgradeCompleteEvent) — recorded at FINISH.

The old timeline was a mix of those semantics, so a Lair would show
up "later" than the Cybernetics that actually came after it. The
v0.5 timeline applies a uniform start-time conversion at the API
response layer (``eventsToStartTime`` in
``apps/api/src/services/perGameCompute.js``) using build / morph /
research durations sourced from
``apps/api/src/services/buildDurations.js``. The same offset is
applied to the median-timings card via
``dnaTimings.firstOccurrenceSeconds``.

**Custom-build rule evaluator follows the same start-time
semantic.** The Save-as-Build button on the BuildOrderTimeline and
the BuildEditorModal both author rules off the start-time view the
user sees on screen. To keep "what you see is what fires", the
cloud rule evaluator now matches against start-time events too —
``eventsToStartTime`` is applied inside
``customBuilds.tagSingleGame`` and inside
``perGame.listForRulePreview``, the two event sources every rule-
evaluator code path reads from (post-write classification, the
``/v1/custom-builds/preview-matches`` endpoint, the per-slug
``reclassify`` flow, and ``reclassifyAll``). New saves are coherent
with their matches end to end.

Existing user-saved custom builds were authored against the legacy
mixed-semantic timeline. Their ``time_lt`` thresholds will now match
slightly more games than before — events appear earlier under the
start-time semantic, so a "Lair before 6:00" rule that previously
required Lair-finish-by-6:00 now requires Lair-start-by-6:00 (which
allows games where Lair finished as late as ~6:57). The shift is at
most one entity's build duration; for upgrades this is up to ~100s.
Re-saving a build via the editor recalibrates it against the new
view.

**What does NOT change:** the ML training surface
(``MLService.recentEventsForUser``) and the agent's local detection
(``detectors/opponent.py``, ``detectors/user.py``) continue to
operate on recorded timestamps. ML models stay valid against their
training distribution, and ``BUILD_DEFINITIONS`` descriptions in
``SC2Replay-Analyzer/detectors/definitions.py`` still describe
agent-side detection that runs off the same recorded-time data it
always did.

### Fixed + Added (cloud v0.5.0 + agent v0.5.0) — overlay widgets are fully cloud-driven, with a Test button per widget

The hosted OBS overlay was bleeding through with most widgets blank
because the agent's ``push_overlay_live`` helper had been wired in
``api_client.py`` but never actually invoked from any pipeline path.
Streamers using only the website (no desktop agent) saw nothing for
every widget except the Session card, which had no socket data flow at
all. This release closes both gaps and adds a per-widget Test button
so streamers can validate their OBS layout without needing a real
ladder match.

- **New ``OverlayLiveService``** (``apps/api/src/services/overlayLive.js``)
  derives a complete ``LiveGamePayload`` from one freshly-ingested
  game plus the user's broader cloud history. Cloud-side derivation
  means every widget — Opponent identity, Match result, Post-game,
  MMR delta, Streak, Cheese alert, Rematch, Rival, Rank, Meta, Top
  builds, Favourite opening, Best answer, Scouting tells — renders
  off the same data the dashboard already holds. The agent no longer
  needs an overlay socket of its own; it just uploads games as
  before.
    - **Per-widget data sources.** ``buildFromGame`` reads ``streak``
      from the most-recent 20 games, ``mmrDelta`` from the previous
      game's ``myMmr``, ``rank`` (league + tier) from a Blizzard
      cutoff table indexed by MMR, ``rival`` / ``headToHead`` /
      ``favOpening`` / ``predictedStrategies`` / ``scouting`` /
      ``rematch`` from the opponents row, ``topBuilds`` and
      ``bestAnswer`` from the games collection cross-tabbed by
      matchup, and ``meta`` from opponent-strategy share for the
      matchup. Cheese probability is derived from the opponent's
      stored strategy via a small keyword set ("Pool first", "Proxy",
      "Cannon rush", "All-in", etc.) so the alert lights up without
      a separate detector pass.
- **New ``POST /v1/overlay-events/test``** route fires a synthetic
  ``overlay:live`` (and ``overlay:session`` for the session widget)
  payload at one specific widget — or all widgets at once — so the
  streamer can preview the OBS layout. Reuses the per-token rate
  limiter the agent's live route uses, so a Test mash can't flood the
  socket.
- **Settings → Overlay UI rewrite.** Each widget URL now has a Test
  button beside Copy. A "Test all" button on the active token header
  lights every enabled widget at once. Disabled widgets show a
  greyed-out Test button (it would no-op anyway). The previous
  "needs agent" / "cloud" badges are removed because every widget
  now works from cloud-derived data — the only remaining requirement
  is that games actually exist in the cloud, which the desktop
  agent provides.
- **Cloud-driven Session widget** (carries forward from the same
  PR's earlier work). The ``games`` collection picks up the new
  ``overlay:session`` socket event; the route layer recomputes
  per-overlay-socket on every successful ingest so today's W-L
  ticks live.
- **Agent now uploads ``myMmr``** alongside every game so the cloud
  derivation can compute MMR delta and rank without an external
  pulse lookup. ``CloudGame.my_mmr`` defaults to ``None`` for non-
  ranked replays where sc2reader doesn't surface it. Game schema
  now allows the field on the ingest path.
- **Coverage.** ``overlayLive.test.js`` (28 cases) locks the
  ``buildFromGame`` derivation, the sample-payload helpers, the test
  endpoint behaviour, and the post-ingest fan-out to active tokens.
  ``overlaySession.test.js`` (10 cases) and ``socketAuthOverlay.test.js``
  (7 cases) cover the session-card and overlay-handshake paths
  introduced in the same PR. All 306 API tests pass.
### Added (agent v0.5.0 + cloud v0.4.6) — sc2replaystats-style macro breakdown

- **Macro Breakdown reordered.** The Active Army & Workers chart now
  sits between the top-3 KPI cards and "Where the score went" —
  what the user looks at first instead of last. The penalty bars
  and leaks lists move down accordingly.
- **Interactive chart with hover crosshair + tooltip.** Mirrors
  sc2replaystats: a vertical line tracks the cursor, dots highlight
  each side's value at the hovered tick, and a floating tooltip
  shows army value (Σ minerals + gas across non-worker units) and
  worker count for both players. Hovered time is also lifted into a
  shared section state so the unit-composition strip below the
  chart stays in sync.
- **"Live" unit composition snapshot below the chart** — race-correct
  worker pill plus army units sorted by mineral+gas cost descending,
  rendered with the existing SC2 unit icon registry. Each side gets
  its own card with the player name, race chip, and total army
  value. Falls back to a friendly "re-sync your agent" hint on
  payloads without ``unit_timeline``.
- **Replay Player Unit Statistics table.** Player / Team / MMR /
  Units Produced / Units Killed / Structures Killed / Workers Built
  / Supply Blocked / APM / SPM. Switches to a stacked card layout
  on mobile so the long column list stays legible without
  horizontal scroll.
- **Army value uses real unit cost catalog instead of food × 8.**
  New ``apps/web/lib/sc2-units.ts`` carries the LotV mineral / gas /
  supply table for every unit and building. ``computeArmyValue``
  sums (minerals + gas) across non-worker, non-building units in
  the unit_timeline composition map — matching how
  sc2replaystats's "army value" headline is computed. Pre-v0.5
  payloads fall back to ``food_used × 8`` so the chart line shape
  stays continuous while users re-sync.
- **Agent v0.5.0 wire-payload additions:**
    - ``unit_timeline`` (downsampled to the same 30 s ticks as
      ``stats_events``) carries per-tick army composition for both
      players. Powers the chart's army-value series, the hover
      tooltip, and the unit-composition snapshot.
    - ``player_stats`` summary records the cumulative born/died
      counters the event extractor populates during its tracker
      walk (units produced / killed / lost, workers built,
      structures built / killed / lost), merged with average
      APM/SPM from the ``apm_curve``. Drives the new stats table.
- **Event extractor counters.** ``SC2Replay-Analyzer/core/event_extractor.py``
  now tracks per-player cumulative counters and a mirrored opponent
  building lifetime dict so structure-kill attribution works in
  2-player games. Uses sc2reader's ``UnitDiedEvent.killing_player_id``
  when present and falls back to "the other player got the kill"
  for replays where the engine couldn't attribute. Additive only —
  existing scoring and unit_timeline outputs unchanged.
- **Schema:** ``apps/api/src/validation/gameRecord.js`` declares the
  new ``unit_timeline`` and ``player_stats`` fields on
  ``macroBreakdown`` (both already passed through
  ``additionalProperties: true``; explicit declarations help
  validation errors and documentation).

### Fixed + Added (cloud v0.4.5) — opponent counter dedupe + admin dashboard

- **Per-opponent counters no longer double-count on re-upload.** The
  ``games`` ingest path used to call ``opponents.recordGame``
  unconditionally, which $inc-ed ``gameCount`` / ``wins`` /
  ``losses`` / ``openings.<X>`` on every call. Re-syncs (which clear
  the agent's local ``state.uploaded`` and re-walk every replay)
  would re-upload existing gameIds — the slim ``games`` row deduped
  on ``(userId, gameId)`` correctly, but the opponent counter
  silently inflated. Fix: gate ``recordGame`` on the ``created``
  flag returned by ``games.upsert``. Re-uploads now route through a
  new ``opponents.refreshMetadata`` method that $sets the
  legitimately-drifting fields (mmr, lastSeen, displayName,
  pulseCharacterId) without touching counters. Regression tests in
  ``opponentsRecount.test.js`` lock the behaviour down.
- **New ``AdminService`` + ``/v1/admin/*`` routes** for operational
  admin tasks. Every route gated by the existing
  ``SC2TOOLS_ADMIN_USER_IDS`` allowlist:
    - ``GET /admin/storage-stats`` — per-collection size, document
      counts, and totals.
    - ``GET /admin/users`` — paginated list (cursor on lastActivity)
      with game + opponent counts, optional userId search.
    - ``GET /admin/users/:userId`` — detail snapshot with totals,
      first/last activity, top-5 opponents.
    - ``POST /admin/users/:userId/rebuild-opponents`` — drop +
      re-derive that user's opponents from games (the counter-fix
      recovery tool).
    - ``POST /admin/me/rebuild-opponents`` — same op against the
      caller's own userId (the most common admin action).
    - ``POST /admin/users/:userId/wipe-games`` — admin-side GDPR
      purge; cascades through ``GdprService.wipeGames``.
    - ``GET /admin/health`` — Mongo ping latency, server uptime,
      Node version, configured ``GAME_DETAILS_STORE`` backend.
- **Admin SPA refactored from a single moderation queue to a
  multi-tab dashboard** (``apps/web/app/admin/*``):
    - Responsive shell with desktop sidebar / mobile drawer.
    - **Dashboard** — per-collection storage stats; primary view.
    - **Users** — paginated list with detail drawer, search, and
      one-click "Rebuild opponents" / "Wipe games" actions.
    - **Tools** — "Fix my counters" + targeted rebuild + targeted
      wipe-games. Inline confirmation prompts for destructive
      actions (no modal).
    - **Moderation** — existing community reports queue.
    - **Health** — auto-refreshing dependency status (Mongo ping,
      uptime, configured backend).

### Changed (cloud v0.4.4) — heavy-field cutover + pluggable storage backend

The v0.4.3 dual-write infrastructure ships its read-side cutover in
this release. Every consumer of the four heavy fields (``buildLog``,
``oppBuildLog``, ``macroBreakdown``, ``apmCurve``) now goes through
``GameDetailsService``; the inline copies on the ``games`` collection
are scheduled for removal by a migration script.

- **All readers and writers cut over.** ``perGameCompute`` (build
  order, macro breakdown, APM curve, custom-build preview cursor),
  the ``opponents`` profile loader (via batched ``findMany``), and
  the ``ml._writeTrainingNdjson`` pipeline now hydrate heavy fields
  through ``GameDetailsService`` instead of reading them inline. The
  ``writeMacroBreakdown``, ``writeApmCurve``, and
  ``writeOpponentBuildOrder`` paths persist to the detail store and
  ``$unset`` the legacy inline copies in the same update so each
  recompute incrementally trims the games doc.
- **Pluggable storage backend.** ``GameDetailsService`` no longer
  talks to MongoDB directly — it delegates to a backend implementing
  the contract in ``services/gameDetailsStore.js``:
    - ``MongoDetailsStore`` (default): in-database, queryable, no
      external dependency.
    - ``R2DetailsStore``: Cloudflare R2 / AWS S3 / Backblaze B2 via
      ``@aws-sdk/client-s3``. Stores each game's heavy blob as a
      single gzip-compressed JSON object at
      ``${prefix}/${userId}/${gameId}.json.gz``. Build logs compress
      ~6× on real payloads (~30 kB raw → ~5 kB at rest).
- **Backend selected at runtime.** Set ``GAME_DETAILS_STORE=r2`` plus
  ``R2_ENDPOINT`` / ``R2_BUCKET`` / ``R2_ACCESS_KEY_ID`` /
  ``R2_SECRET_ACCESS_KEY`` (and optional ``R2_REGION`` / ``R2_PREFIX``)
  to flip backends without a code change. Partial R2 configuration
  fails at boot with a clear error rather than silently falling back
  to Mongo.
- **Spatial extracts deliberately stay inline on ``games``.** They
  drive the heatmap aggregations in ``services/spatial.js`` which
  filter on ``spatial.*`` fields server-side; an object-storage
  backend can't serve those queries. Spatial is small (~5 kB / game)
  so the savings would have been marginal anyway.

#### Migrations (run in this order)

1. ``2026-05-07-trim-early-build-logs.js`` — drops ``earlyBuildLog`` /
   ``oppEarlyBuildLog`` from existing docs (v0.4.3 carry-over).
2. ``2026-05-07-backfill-game-details.js`` — populates the
   ``game_details`` collection from existing inline heavy fields.
3. ``2026-05-08-unset-heavy-from-games.js`` — drops the four heavy
   fields from ``games``. Refuses to run unless step 2 has populated
   the matching detail rows; pass ``--force`` to override.
4. ``2026-05-08-mongo-to-r2.js`` (optional) — copies every detail
   blob into R2 and rewrites the Mongo row to a slim
   ``storedIn: 'r2'`` stub. Run before flipping
   ``GAME_DETAILS_STORE=r2`` so back-history is reachable through the
   new backend.

#### Storage projection update

After the v0.4.4 cutover plus R2 offload, per-game cost decomposes:

| Surface | Bytes / game |
|---|---|
| ``games`` slim row | ~3 kB on disk |
| ``game_details`` Mongo metadata stub (when R2-backed) | ~120 B |
| R2 object (gzip-compressed) | ~5 kB |

For 1M games:

| Stack | Atlas storage | R2 storage | Estimated monthly |
|---|---|---|---|
| Mongo-only (v0.4.4) | ~9 GB | — | M10 / $60 |
| Mongo + R2 (this release, R2 enabled) | ~3 GB | ~5 GB | M2 + R2 / **~$10** |

### Changed (agent v0.4.3 + cloud) — storage trim, ~37% smaller per-game payload

- **`earlyBuildLog` / `oppEarlyBuildLog` removed from the wire shape.**
  Both arrays were exactly `buildLog` / `oppBuildLog` filtered to
  `time < 5:00`, costing roughly 6 kB of redundant storage per game.
  The agent stops sending them; the cloud derives them on read in
  the three services that need the early window
  (`perGameCompute.buildOrder`, `dnaTimings`, `ml._writeTrainingNdjson`)
  via the new `readEarlyBuildLog` / `readOppEarlyBuildLog` helpers.
  Pre-v0.4.3 docs are unaffected — the readers fall back to the
  stored field when present, derive from the full log when absent.
- **`stats_events` / `opp_stats_events` downsampled to 30 s buckets.**
  sc2reader fires `PlayerStatsEvent` every ~10 s, which is finer
  resolution than the SPA's `ResourcesOverTimeChart` and
  `ActiveArmyChart` ever render — chart pixels are 5–10 s wide at
  typical widths, so the 10 s grid is invisible. The agent now keeps
  only the first event in each 30 s game-time bucket before shipping
  the macroBreakdown payload, cutting each array to roughly a third
  of its original size (~12 kB / game saved). `compute_macro_score`
  still runs on the FULL stream so leak detection / SQ / penalties
  are unaffected by the wire-level downsample.
- **`game_details` collection introduced (dual-write, read cutover deferred).**
  Heavy per-game fields (`buildLog`, `oppBuildLog`, `macroBreakdown`,
  `apmCurve`, `spatial`) are mirrored into a new `game_details`
  collection keyed on the same `(userId, gameId)` tuple as `games`.
  Existing readers continue to read heavy fields from `games` — the
  read-side cutover (which lets us $unset the duplicates from `games`
  to actually reclaim ~40 kB / doc) is the next storage refactor and
  ships separately. The split sets up Option C (object-storage offload
  of the heavy fields) cleanly: once readers cut over, swapping the
  `gameDetails` backend from MongoDB to R2/S3 is a service-level
  change without touching the rest of the codebase.

#### Migrations

Two one-shot scripts ship with this release. Both are idempotent and
support `--dry-run`.

- `apps/api/src/db/migrations/2026-05-07-trim-early-build-logs.js`
  $unsets `earlyBuildLog` / `oppEarlyBuildLog` from every existing
  game document. Reclaims the ~6 kB / doc immediately (after the
  next WiredTiger compaction).
- `apps/api/src/db/migrations/2026-05-07-backfill-game-details.js`
  copies the heavy fields from existing games into the new
  `game_details` collection so the dual-write history is complete.
  Read-side cutover follow-up will then rely on this row existing
  for every game.

#### Storage projection

For 5k games (current scale): 237 MB → ~150 MB data size
(~70 MB → ~45 MB on disk).

For 30k games (the ceiling we're trending toward): ~1.5 GB → ~900 MB
data size (~430 MB → ~270 MB on disk) — comfortably inside Atlas M2
Shared (2 GB) instead of pushing past M5.

For 1M games (long-horizon target): ~9 GB on disk after the read-side
cutover lands; layering Cloudflare R2 / S3 on top of `game_details`
drops Atlas-side storage to ~1 GB and shifts ~8 GB to ~$0.12 / month
of cold object storage.

### Fixed (agent v0.4.2)

- **Replays with very long event streams no longer get rejected by
  the cloud and starve the upload queue.** Long Zerg games routinely
  produced opponent build logs of 8k–14k entries (every Zergling /
  Drone / Overlord birth becomes its own line), well past the API's
  ``maxItems: 5000`` cap on ``oppBuildLog``. The server returned a
  validator rejection (``"/oppBuildLog must NOT have more than 5000
  items"``), the upload worker treated it as a transient error and
  re-enqueued the same job every 2 s, and the bounded queue then
  filled up and silently dropped every fresh replay with
  ``upload_queue_full; dropping ...``. The agent now caps each build
  log at the schema limit (5000 for ``buildLog`` / ``oppBuildLog``,
  1000 for the ``early`` variants) before upload — chronological
  truncation, so the build-order timeline and rules engine still see
  the early/mid game window they care about. A one-line
  ``build_log_truncated ...`` is logged whenever truncation actually
  happens, so this isn't silent.
- **Schema rejections no longer loop.** The upload worker now
  distinguishes a permanent server rejection (200 OK with
  ``rejected: [...]``) from transient transport errors. Permanent
  rejections are recorded in ``state.uploaded`` as ``"rejected"`` so
  the next sweep skips the file instead of re-parsing and re-failing,
  and the worker returns to draining the queue immediately rather
  than sleeping 2 s per failure.

## [agent-v0.4.0] - 2026-05-06

Released as `agent-v0.4.0` on GitHub. Installer:
`SC2ToolsAgent-Setup-0.4.0.exe` (~305 MB).

### Added (agent v0.4.0)

- **MacroBreakdown + APM curve uploaded with each replay.** The agent
  now runs `extract_macro_events` + `compute_macro_score` on every
  parse and ships the structured breakdown (top-3 leaks, all leaks,
  per-sample stats events for both players, SQ/penalties in `raw`)
  alongside the slim game record. Same goes for the windowed APM/SPM
  curve. Without this, the SPA's macro drilldown and Activity-tab APM
  chart fell back to "Macro breakdown not available for this game yet"
  even on freshly uploaded games — the cloud doesn't store .SC2Replay
  binaries, so anything not in the agent payload is unrecoverable
  later. Upload pipeline is fail-soft: if the analyzer imports fail
  (frozen-exe DATAS missing) or `compute_macro_score` raises on a
  malformed replay, the breakdown field is omitted but the game still
  ingests.
- **Opponent build-order timeline derived from `opp_events`.** The
  parser was already extracting opponent buildings/units/upgrades for
  strategy detection (the `opp_strategy` field has worked since
  v0.3.0), but the agent never converted that event stream into the
  `[m:ss] Name` lines the cloud expects. Result: the dual-build
  timeline always rendered the opponent panel as "No opponent build
  extracted yet" even when the strategy detector had clearly walked
  the same data. `_build_log_from_events` now formats both the full
  log and the 5-minute early-game cap. Same fail-soft policy as
  macroBreakdown — empty list on failure, never blocks the upload.
- **Live recompute via Socket.io.** The agent listens for
  `macro:recompute_request` and `opp_build_order:recompute_request`
  events from the cloud and re-uploads the requested replay(s)
  on demand. Drives the SPA's per-game "Recompute now" button and
  the bulk `/macro/backfill/start` flow. Auth is the existing device
  token; the cloud joins the socket into the user's room so events
  fan out to every paired device. Connection is reconnect-on-drop;
  the agent works fine without `python-socketio` installed (degrades
  to "click Resync to apply changes" rather than blocking startup).
- **Per-replay spatial extracts for Map Intel heatmaps.** Each upload
  now includes building positions, proxy classifications (using the
  same 50-world-unit threshold as the offline `BaseStrategyDetector`),
  battle/death markers, and the map's bounding rectangle so the cloud
  can rasterise across N games per map without re-parsing replays.

### Fixed (agent v0.3.4)

- **Dashboard "Active" card showed only one folder.** When the Settings
  tab was configured with multiple `Replays/Multiplayer` directories
  (one per region or BattleTag), the dashboard's status line still read
  `Folder: <first folder only>` — giving the false impression the agent
  was ignoring the rest. `_format_status_lines` in `ui/gui.py` now
  enumerates every watched folder, pluralises the headline
  (`Watching 2 replay folders`), and the status sub-label uses
  `setWordWrap(True)` so long path lists render cleanly.
- **Auto-detect button erased the list instead of populating it.** The
  Settings tab's Auto-detect previously called `self._folder_list.clear()`
  on the assumption the runner would rediscover on next start — but
  the user couldn't see the result, and any folders the auto-scan
  missed would silently disappear. The button now actively scans
  `find_all_replays_roots()` + `all_multiplayer_dirs_anywhere()` and
  populates the list inline, preserving any user-added entries that
  the scan didn't find.
- **Auto-discovery only saw the first Documents location.** The legacy
  `find_replays_root()` returned the FIRST matching `Documents` folder
  and stopped, so a user with both regular `Documents` AND a OneDrive
  copy of the SC2 tree only had one root watched. Replaced with
  `find_all_replays_roots()` (returns every match, deduped by resolved
  path) and `all_multiplayer_dirs_anywhere()` (unions every Multiplayer
  dir across every root). Probed extra Windows locations:
  `Pictures\Documents`, `%USERPROFILE%\Documents`, and
  `%USERPROFILE%\OneDrive\Pictures\Documents`. Both the runner's
  startup discovery and the watcher's `_discover_roots` now use the
  union helper.
- **Replay-parser import error permanently skipped every replay.**
  When `parse_replay_for_cloud` failed to import
  `core.sc2_replay_parser` (frozen-exe DATAS missing, race during
  PyInstaller extract, or a broken install), it returned `None` and
  the watcher's `_handle_replay` recorded the path as `"skipped"` in
  `state.uploaded`. Even after a fix or restart that resolved the
  import, those replays would never re-enter the queue. Introduced
  `AnalyzerImportError` so the watcher can distinguish a systemic
  import failure (don't skip; throttle the log to once per minute;
  retry on next sweep / restart) from a per-replay parse failure
  (skip as before). On recovery the watcher emits
  `analyzer_recovered`. Made `_ensure_analyzer_on_path` more robust:
  it now probes `_MEIPASS`, the exe parent, the exe grandparent, and
  several `parents[n]` levels for source mode, then retries the
  import once after re-probing in case the bundle DATAS finished
  extracting between the first attempt and the retry.

### Fixed (agent v0.3.3)

- **Replay parsing in the frozen exe.** The PyInstaller bundle did not
  ship `reveal-sc2-opponent-main/core/sc2_replay_parser.py`, and even if
  it had, the runtime `sys.path` patcher used a `parents[3]` walk that
  pointed outside `_MEIPASS` once frozen. Result: every `.SC2Replay`
  the watcher saw failed to parse with a flooding `Could not import
  sc2_replay_parser` error and nothing ever uploaded. The spec now
  bundles the reveal package alongside `SC2Replay-Analyzer`, and
  `replay_pipeline._ensure_analyzer_on_path` switches to `_MEIPASS` in
  frozen mode and the repo root in source mode.
- **Open dashboard sent users to a dead domain.** The runner's
  `_dashboard_url_from_api` fallback hard-coded `https://sc2tools.app`,
  which is no longer authoritative. The marketing + dashboard origin is
  `sc2tools.com`. Updated the runner default, the console UI's pairing
  text, the GUI's API-base placeholder, and the NSIS installer's
  `URLInfoAbout` registry value.
- **Dashboard action row clipped its button labels.** Five buttons in
  one row at the window's minimum width forced Qt to shrink each
  button below its natural size, so `Re-sync from scratch` rendered
  with the trailing word past the button border. Split into two rows
  (local vs. external actions), gave each button a `Maximum, Fixed`
  size policy, and used shorter labels with explanatory tooltips so
  the layout stays readable at 820 px wide.

### Added (agent v0.3.3)

- **Multi-folder replay watching.** StarCraft II writes a separate
  `Replays/Multiplayer` directory per (region, battle.net handle)
  pair, so a player on multiple regions or alts needed more than one
  override. State now stores `replay_folders_override` as a list and
  forward-migrates the old `replay_folder_override` string. The
  Settings tab presents a real list with **Add folder…**, **Remove
  selected**, and **Auto-detect** buttons; the dashboard's "Add replay
  folder…" appends rather than replaces; the tray menu shows
  `(+N more)` when more than one folder is being watched. The watcher
  picks up new entries on its next sweep without a restart.

## [Unreleased] - 2026-05-04

### Added

- **Cloud SaaS foundation (Stage A + D + E + F + G slice).** New monorepo
  layout under `apps/`:

  - **`apps/api/`** — Express + MongoDB cloud API (Render-deployable via
    `apps/api/render.yaml`). Clerk JWT auth + long-lived device-token
    auth so the local agent and the web SPA share routes. Per-user
    storage of opponents, games, custom builds. HMAC-pepper hashing of
    opponent battle-tags so PII never lands in the cloud DB. Routes:
    `/v1/health`, `/v1/me`, `/v1/opponents{,/:pulseId}`,
    `/v1/games{,/:gameId}` (POST ingest), `/v1/custom-builds`,
    `/v1/device-pairings/{start,:code,claim}`, `/v1/devices`,
    `/v1/overlay-tokens`. Socket.io live `games:changed` push.
  - **`apps/web/`** — Next.js 15 (App Router) frontend, Vercel-ready.
    Clerk-hosted sign-in (Google + Discord + email/password). Real
    pages: landing, sign-in/up, `/app` analyzer (with live SyncStatus
    pill), `/devices` pairing flow, `/streaming` overlay-token mgmt,
    `/builds` library, public `/overlay/[token]` for OBS Browser
    Source. SWR-driven data fetching with per-request Clerk JWTs.
  - **`apps/agent/`** — Python single-file agent (PyInstaller-ready).
    Watches the user's SC2 Replays folder (watchdog FS events +
    periodic OneDrive sweep), parses each replay through the existing
    `SC2Replay-Analyzer` parsers (chrono fix preserved), uploads to
    `/v1/games`. Tray UI (pystray) with live status + console
    fallback. Atomic state writes for the device token + dedupe
    cursor. Pairing-code flow.

- **`docs/cloud/SETUP_CLOUD.md`** — top-to-bottom 60-90 min setup
  walkthrough covering MongoDB Atlas, Clerk (with optional custom
  Google OAuth credentials), Render, Vercel, custom domain wiring,
  agent install on the gaming PC, OBS overlay configuration, and
  troubleshooting.

### Performance

- **Opponents tab no longer freezes when new replays land.** The
  4-second `setInterval` in `analyzer.js#startWatching` was calling
  `fs.readFileSync` + `JSON.parse` on `MyOpponentHistory.json`
  (~27 MB) and `meta_database.json` (~137 MB) on the main event loop —
  blocking GET `/api/opponents` for hundreds of milliseconds every
  cycle. Replaced with a worker-thread-backed background loader
  (`stream-overlay-backend/lib/background-loader.js{,.worker.js}`)
  that:
  - Detects file changes via the same cheap mtime+size+head/tail
    signature as before.
  - Off-loads the 27 MB JSON parse to a `worker_threads` worker so
    HTTP requests stream through unimpeded.
  - Atomically swaps `dbCache.meta.data` / `dbCache.opp.data` once the
    parse returns.
  - Salvages the valid prefix on truncated mid-write reads (matches
    the existing `salvageJsonObject` algorithm so behaviour parity is
    maintained).
  - Emits the same `analyzer_db_changed` Socket.io event so live SPA
    tabs continue to refresh in real time.

### Tests

- New: `apps/api/__tests__/{hash,gameRecord}.test.js` — 10 cases
  covering HMAC pepper determinism, token randomness, validator
  enums and required fields.
- New: `apps/agent/tests/{test_state,test_config,test_api_client}.py`
  — atomic-write round-trip, env handling, retry/auth behaviour.
- New: `stream-overlay-backend/__tests__/background-loader.test.js`
  — 4 cases asserting worker-driven reload, signature change
  detection, and stable-signature no-op.
- All `tsc --noEmit --strict` clean for `apps/api/`. Unit suites
  green: 10/10 (api), 4/4 (analyzer background loader).

## [1.4.7] - 2026-05-02

### Fixed (critical)

- **``meta_database.json`` mid-write truncation (139 MB) lost ~14 game
  records and silently failed strict parse.** Same corruption family as
  the v1.4.6 ``MyOpponentHistory.json`` issue, different mode: the file
  ended abruptly inside a half-written game record (3 unclosed opening
  braces at EOF, ~100 KB of trailing partial data), failing strict
  ``JSON.parse`` at byte 136,981,034 of 136,981,633. Builds tab still
  worked because the SPA tolerates an empty ``dbCache.meta.data`` for
  some queries, but per-build / per-game drilldowns degraded silently.

  Two-part fix:

  1. **Recovery script**: ``data/recover_meta_database.py`` salvages the
     current file by walking backward through ``},\n`` record boundaries
     until parse succeeds (recovers ~99.92%, 11,501 game records),
     loads the latest cleanly-parseable backup
     (``meta_database.json.pre-reclassify-2026-05-01T19-02-22-861Z``,
     11,515 records) as the base, and merges per-build with games
     deduped on the ``id`` field (``date|opponent|map|game_length``).
     When the same id appears in both, the SALVAGED-CURRENT version
     wins (carries post-reclassify enrichment + same-day updates).
     Quarantines the corrupt original + backup-of-record under
     ``data/.recovery-meta-<UTC>/`` with a README.
  2. **Backend salvage hardening**: fixes a bug in
     ``stream-overlay-backend/analyzer.js`` ``salvageJsonObject`` where
     the ``bounds.length < 50`` cap inside the boundary-collection loop
     kept only the FIRST 50 ``},\n`` boundaries (from the *start* of
     the file). For any file with more than 50 record boundaries (e.g.
     ``meta_database.json`` at ~72,000) the truncated tail was never
     reached and salvage silently failed. v1.4.7 collects ALL
     boundaries then attempts the LAST 500 (walking backward from end
     of file). In practice salvage of a single mid-record truncation
     succeeds in fewer than 100 attempts; the 500-cap is a fast-path
     safeguard so we don't try tens of thousands of attempts on a
     totally garbage file.

  Net effect: any future ``meta_database.json`` mid-write truncation
  is recovered transparently on backend boot instead of returning
  empty data.

## [1.4.6] - 2026-05-02

### Fixed (critical)

- **Opponents page silently lost full game history (data corruption).**
  Production user reported the Opponents tab only showed today's matches
  while Builds correctly showed full history. Investigation revealed
  ``data/MyOpponentHistory.json`` was a 27.7 MB file whose first 45,184
  bytes were a complete top-level JSON dict (6 opponents only) followed
  by ~27 MB of pure trailing whitespace -- the corruption signature of
  an in-place re-write that produced a shorter payload but did NOT
  truncate the destination file before writing the new content. The
  backend's existing ``salvageJsonObject`` always APPENDED ``\n}\n`` to
  the trimmed content, producing ``{...}\n}\n`` (extra closing brace,
  parse fails). With every salvage strategy missing, ``dbCache.opp.data``
  fell back to ``{}`` and the Opponents tab silently showed nothing
  beyond what the live PowerShell scanner had written that session.

  Two-part fix:

  1. **Recovery of the live file.** Performed an offline merge of the
     6 surviving opponents (sliced to the first balanced top-level
     brace pair) with the most recent large parseable backup
     (``MyOpponentHistory.json.pre-merge-unknown-20260501T143757Z``,
     3,178 opponents / 11,020 game records). Per-opponent merge took
     the union of games (deduped on ``(Date, Map, Result)``) and
     ``max(Wins, Losses)`` per matchup. Result: 3,183 opponents /
     11,033 game records, atomically written via tmp + ``os.replace``,
     verified to parse cleanly. Corrupt original + backup-of-record
     quarantined under ``data/.recovery-<UTC-timestamp>/`` with a
     README explaining root cause + restoration approach.
  2. **Backend salvage hardening.** ``stream-overlay-backend/
     analyzer.js`` ``salvageJsonObject`` rewritten with three ordered
     strategies (cheapest -> most aggressive): trim-trailing-whitespace
     (catches the exact production corruption above), slice-to-first-
     balanced-brace-pair (string- and escape-aware so quoted braces
     don't fool the depth counter -- catches the "well-formed dict
     followed by non-whitespace garbage" case e.g. a half-written
     second copy appended after the first object), then the original
     append-close-brace + drop-trailing-records strategies (catches
     "write was interrupted mid-record"). Returned dict carries a
     non-enumerable ``__salvageStrategy`` hint so the reload path can
     log which strategy hit. This means a future occurrence of the
     same corruption mode is recovered transparently on backend boot
     instead of returning empty data.

## [1.4.5] - 2026-05-02

### Fixed (critical)

- **Session double-counting wins/losses.** ``/api/replay`` had no
  idempotency check, so any duplicate POST for the same replay
  (real-world causes: OneDrive sync emitting 2-3 ``on_created`` events
  for one ``.SC2Replay`` file as it's uploaded; watcher restart picking
  up a replay that landed mid-restart in both the live event and the
  catch-up sweep) would increment ``session.wins`` / ``session.losses``
  / streak / MMR delta twice. Symptom: session widget showed 0-2 when
  only one game was actually lost. Adds a bounded LRU cache (200 entries)
  keyed on ``gameId`` at the top of the handler; duplicates respond
  ``{ ok: true, duplicate: true }`` and bypass all state mutations.
  Payloads missing ``gameId`` (legacy callers, manual POSTs from
  ``/static/debug.html``) fall through unchanged.

### Added

- **Browser auto-open in unified launcher.** Both ``START_SC2_TOOLS.bat``
  copies (repo-root and ``reveal-sc2-opponent-main/``) now have a
  ``[5/5]`` step that polls ``http://localhost:3000/api/health`` for up
  to 30 seconds and then opens ``http://localhost:3000/analyzer/`` in
  the user's default browser via ``Start-Process``. The legacy
  ``SC2ReplayAnalyzer.py`` shim used to do this with
  ``webbrowser.open()``; now that the unified launcher is the only
  supported entry point, the SPA-launch step lives there too. If the
  health probe times out the launcher prints a yellow warning and
  opens the browser anyway -- worst case the user gets a refreshable
  "site can't be reached" page instead of nothing happening.

### Fixed

- **Multi-region opponent matching with MMR-band disambiguation.**
  Replaces the v0.9.5 "first user region with a name hit wins" loop in
  ``Reveal-Sc2Opponent.ps1``. The old logic had two failure modes that
  showed up the moment a player had identities on more than one region
  (e.g. ``us`` + ``eu``):

  1. Opponent name collisions across regions made the script lock onto
     whichever region Pulse's lagged ``lastPlayed`` happened to point
     at -- typically NOT the region the user was actually on after
     switching servers. Symptom: ``[Pulse] Active region detected: EU``
     followed by an MMR for the wrong "John#1234".
  2. When the strict ``caseSensitive=true`` probe missed in every user
     region, the script logged ``"Opponent name not found in any user
     region"`` and then silently fell back to ``Find-PlayerProfile`` +
     ``Get-OpponentTeams`` -- which often DID find a match using the
     same query shape, in a region the user was never told about.
     Symptom: log says "not found" but the next line shows a real MMR
     and head-to-head record (potentially for the wrong player).

  The new logic probes EVERY user region (strict pass, then a
  case-insensitive retry across every region if strict misses
  everywhere), fetches each Pulse hit's team data (rating + last
  played), and scores each candidate by MMR delta against the user's
  rating ON THAT REGION. A 400-MMR band rejects out-of-band collisions.
  The region containing the best in-band candidate wins; tiebreak on
  recency. If no region has an in-band match the fallback prefers the
  user's highest-MMR team for the current race instead of stale
  Pulse-recency. Every decision prints a transparent diagnostic line
  (``[Pulse] Active region: us (in-band MMR match (delta=72,
  case-sensitive))``) so the user can see exactly which signal won.

  Also bumps the embedded ``Reveal-Sc2Opponent.ps1`` ``PSScriptInfo``
  ``.VERSION`` from ``0.9.5`` to ``0.9.6``.

- **``-ActiveRegion`` rejected multi-region configs from subprocess
  launchers.** ``Reveal-Sc2Opponent.ps1``'s parameter declared
  ``[ValidateSet("us", "eu", "kr", "cn")] [string[]]$ActiveRegion``,
  which validates each array element against the set. When the Python
  launcher (``scripts/poller_launch.py`` -> ``core/launcher_config.
  build_poller_argv``) passed ``-ActiveRegion us,eu`` via
  ``subprocess.Popen``'s argv list, ``powershell.exe -File`` bound it
  as a single string ``"us,eu"`` and ValidateSet rejected it before
  the script body ran. Removes the ``ValidateSet`` attribute and
  validates manually after splitting on comma -- both shapes
  (``@("us","eu")`` and ``"us,eu"``) now work, bad codes still
  produce a clean error and ``exit 1`` instead of a noisy parameter
  binding error.

### Removed (Stubbed)

- **``SC2Replay-Analyzer/SC2ReplayAnalyzer.py`` retired.** The legacy
  standalone launcher used to spawn its own ``npm start`` /
  ``replay_watcher`` / ``Reveal-Sc2Opponent.ps1`` stack and open the
  SPA in a browser. It is no longer referenced by anything in the
  active launch chain, but Windows shortcuts and Start-menu pins
  pointing at it still fired and double-launched everything against
  the unified ``START_SC2_TOOLS.bat`` already running. Replaced with a
  50-line stub that pops a Tk ``messagebox`` (with a ``print + input``
  fallback for headless / pythonw-without-Tk) telling the user to use
  ``START_SC2_TOOLS.bat`` instead, then ``sys.exit(0)``. Original
  contents preserved in git history (``git log -p
  SC2Replay-Analyzer/SC2ReplayAnalyzer.py``) if revival is ever
  needed.

## [1.4.0] - 2026-05-02

### Added

- **Watcher hot-reloads ``data/config.json``.** ``watchers/replay_watcher.py``
  now polls ``data/config.json``'s mtime every ~5 s and reconciles the
  running watchdog observer with the latest ``paths.replay_folders`` /
  player handle. Folders the user removes in Settings -> Folders are
  unscheduled in place; folders they add are scheduled and run through
  the catch-up scan so games played before the folder was registered
  still land in the DB. Saving from the SPA no longer requires
  restarting the watcher window.

- **``Settings -> Profile`` runtime helpers.** New
  ``SettingsRuntimeControlsGroup`` renders below the identities group
  and exposes a "Restart Poller" button + helper text explaining the
  watcher hot-reload behaviour. The button POSTs to a new
  ``/api/runtime/restart-poller`` endpoint that spawns a fresh
  ``scripts/poller_launch.py`` (which kicks off a new
  ``Reveal-Sc2Opponent.ps1`` window) so the poller picks up the
  saved identity. The old PowerShell window keeps running until the
  user closes it (different console owner; we can't kill it from
  here), so the success toast tells them so explicitly.

- **``/api/runtime/*`` router.** New ``stream-overlay-backend/routes/
  runtime.js`` owns helper-process restart endpoints:
  ``GET /api/runtime/status`` returns ``{ watcher_hot_reload_sec,
  can_restart_poller }`` so the SPA can decide which controls to render;
  ``POST /api/runtime/restart-poller`` spawns the poller via
  ``poller_launch.py`` (detached, ``stdio: 'ignore'``) and returns the
  child PID.

### Fixed

- **``START_SC2_TOOLS.bat`` hardcoded ``C:\SC2TOOLS``.** The launcher set
  ``TOOLS_ROOT=C:\SC2TOOLS`` and then ``cd /d %TOOLS_ROOT%\reveal-sc2-opponent-main``,
  so any user who unpacked the toolkit on a different drive
  (e.g. ``E:\response\sc2tools``) saw every panel die immediately with
  ``The system cannot find the path specified.`` -- the Replay Watcher
  window in particular flashed the error before exiting because
  ``cd /d`` failed before ``py -m watchers.replay_watcher`` could run.
  Both copies of ``START_SC2_TOOLS.bat`` (repo root and
  ``reveal-sc2-opponent-main\``) now derive ``TOOLS_ROOT`` / ``ROOT``
  from ``%~dp0`` (matching the existing pattern in
  ``reveal-sc2-opponent.bat``) so the launcher works regardless of
  install drive, and they bail out with an explicit "expected path"
  message when the layout is wrong instead of silently spawning broken
  child windows. Honours hard rule #6 (UX must work without docs).

- **Replay watcher honoured a hardcoded ``WATCH_DIR``.**
  ``watchers/replay_watcher.py`` had a hardcoded
  ``DEFAULT_WATCH_DIR = r"C:\Users\jay19\OneDrive\..."`` and ``main()``
  only ever watched that single path. The wizard already writes
  ``paths.replay_folders`` to ``data/config.json`` -- the watcher just
  wasn't reading it. ``main()`` now resolves targets in priority order
  (CLI override -> ``paths.replay_folders`` -> legacy
  ``DEFAULT_WATCH_DIR``), runs the catch-up scan against every
  configured folder, and schedules a watchdog observer per folder so
  users with multiple SC2 installs (Battle.net + PTR, OneDrive +
  Documents) get all of them watched. Missing folders are logged and
  skipped instead of failing the whole watcher.
  ``_read_player_handle()`` now also falls back to
  ``identities[0].name`` when neither legacy ``last_player`` /
  ``player_name`` key is present.

- **Pulse poller hardcoded ``(?i)ReSpOnSe`` for "who's me?".**
  ``Reveal-Sc2Opponent.ps1`` already accepted ``-PlayerName`` for Pulse
  ID resolution but two later regex matches (``Get-MyResult`` and the
  live opponent-detection block) ignored the parameter and matched a
  hardcoded ``(?i)ReSpOnSe``. For every other user, ``$Me`` resolved
  to ``$null`` and the result was silently lost. The script now builds
  a ``$Script:MyNamePattern`` from ``-PlayerName`` (or, when blank,
  derives one by querying Pulse ``/character/<id>`` for each resolved
  ``$CharacterId``) and uses that pattern in both places. The launcher
  side (``launcher_config.build_poller_argv``) was also updated to
  pass ``-PlayerName`` alongside ``-CharacterId`` so the PS1 always has
  the configured handle to work with.

- **``poller_launch.py`` required the legacy sibling project on disk.**
  ``scripts/poller_launch.py`` did
  ``sys.path.insert(0, _REPO_ROOT.parent / "SC2Replay-Analyzer")`` and
  then ``import launcher_config``. Post-merge installs that no longer
  carry the legacy sibling crashed Box 4 with a ``ModuleNotFoundError``
  the moment the launcher started it. ``launcher_config`` is now
  shipped inside the merged repo at ``core/launcher_config.py``;
  ``poller_launch.py`` imports from there first and falls back to the
  legacy sibling location only when the merged copy isn't present.

- **Launcher: only 1 of 3 cmd windows loaded.** ``START_SC2_TOOLS.bat``
  Box 1 pointed at ``C:\SC2TOOLS\SC2Replay-Analyzer\SC2ReplayAnalyzer.py``,
  a separate Python project that no longer exists after the merge into
  ``reveal-sc2-opponent-main``, so the backend never started. Boxes 2
  and 3 used ``python`` while Box 1 used ``py`` -- whichever variant
  was missing from PATH made those panels error out immediately.
  Restructured to ``[1/4]``: Box 1 runs ``npm start`` directly from
  ``stream-overlay-backend``; Box 2 launches the analyzer GUI silently
  via ``pythonw -m gui.run_gui`` (logs go to ``data/analyzer.log``);
  Boxes 3 and 4 use a top-of-file ``%PYTHON%`` variable so the
  interpreter choice is consistent across panels; Box 4 calls
  ``scripts/poller_launch.py`` directly instead of double-shelling
  through ``reveal-sc2-opponent.bat``. ``reveal-sc2-opponent.bat``
  itself now prefers ``py`` and falls back to ``python`` so the
  standalone path still works when only one of the two is installed.

- **Onboarding: replay import failed during the wizard.**
  ``pickPythonProjectDir()`` in ``stream-overlay-backend/analyzer.js``
  only looked for the legacy sibling ``SC2Replay-Analyzer`` directory.
  Since the project is now merged into ``reveal-sc2-opponent-main``
  the lookup returned ``null`` and the wizard surfaced "Could not
  locate the SC2Replay-Analyzer Python project." Even after the path
  check, ``scripts/macro_cli.py`` flat-out didn't exist -- the
  ``/macro/backfill/start`` endpoint was shelling out to a script
  that was never written.

### Added

- ``scripts/macro_cli.py`` -- new CLI with a ``backfill`` subcommand
  that reads the configured replay folders from
  ``data/config.json`` (``paths.replay_folders``), recursively scans
  every ``.SC2Replay`` file, parses each one with
  ``core.sc2_replay_parser.parse_live`` (load_level=2, fast), and
  imports the resulting games into ``data/meta_database.json`` via
  ``AnalyzerDBStore``. Idempotent on game id; supports
  ``--db`` / ``--player`` / ``--limit`` / ``--force``. Emits one
  newline-delimited JSON object per replay so the onboarding wizard
  can render a live progress bar:
  ``{"progress": {"i": N, "total": T, "ok": bool, "file": "..."}}``
  followed by a single
  ``{"result": {"updated": ..., "errors": ..., "skipped": ..., "total": ...}}``.

### Changed

- ``analyzer.js`` ``pickPythonProjectDir()`` now prefers the merged
  layout: ``ROOT`` itself (the ``reveal-sc2-opponent-main`` project)
  is treated as the Python root when ``ROOT/core`` exists, so the
  ML and macro CLIs no longer require a sibling SC2Replay-Analyzer
  directory. The legacy sibling and ``C:\SC2TOOLS\SC2Replay-Analyzer``
  paths are kept as fallbacks for un-migrated installs.

## [1.3.0] - 2026-05-01

### Added

- **Standalone onboarding diagnostic tool.** New
  ``tools/diagnose-onboarding.bat`` and ``tools/diagnose-onboarding.py``
  let a non-developer user diagnose the opaque
  ``no_human_players_found`` Step 3 failure on their own machine. The
  .bat double-clicks; the script auto-discovers replay folders across
  OneDrive variants (including corporate ``OneDrive - Company``),
  classic Documents, Dropbox, Google Drive, iCloud, Box, public
  Documents, plus a bounded recursive walk of every drive letter for
  ``StarCraft II/Accounts`` (skipping ``Windows``, ``$Recycle.Bin``,
  ``System Volume Information``, ``node_modules``, etc.). Drag-drop a
  Multiplayer folder onto the .bat to override auto-discovery. Probes
  ``sc2reader``, parses the newest five replays, and writes
  ``diagnose.txt`` with a one-line VERDICT and per-replay parse
  outcome — the user emails the file back instead of reading the
  wizard''s opaque error code. Reads only; never modifies state.

### Fixed

- **Skip buttons unblock dead-end wizard steps.** Step 3 (Identity)
  could trap a user whose replays sc2reader could not parse: the Next
  button stayed disabled at ``Next (0)`` with no escape. Steps 2
  (Replays) and 4 (Race) had the same dead-end shape when nothing was
  selected. Each step now renders a ghost-styled ``Skip`` button next
  to the disabled Next when no choice has been made; the happy path
  UI is unchanged when a selection exists. Schema-wise, the Apply
  step already tolerates ``identities: []`` (no ``minItems``), and
  ``preferred_races`` is not schema-validated, so Skip on Steps 3 and
  4 produces a valid config the user can fill in later from
  Settings → Profile. Step 2 Skip remains available for symmetry but
  Apply still fails on empty ``replay_folders`` (schema requires
  ``minItems: 1``); documented as a known follow-up.

## [1.2.0] - 2026-05-01

### Added

- **Launcher orchestrates all three runtime components.** ``SC2Replay-
  Analyzer/SC2ReplayAnalyzer.py`` now spawns the Express backend, the
  live ``watchers.replay_watcher``, and the SC2Pulse PowerShell poller
  (``Reveal-Sc2Opponent.ps1``) under one process tree, registers each
  child with ``atexit`` for clean shutdown, and waits for
  ``/api/health`` before opening ``/analyzer/`` in the browser. Closes
  the gap where ``packaging/installer.nsi``''s desktop and Start Menu
  shortcuts ran the launcher — which only spawned the backend — while
  ``START_SC2_TOOLS.bat`` was the only path that booted all three
  windows. New installs and existing shortcuts now pick up watcher +
  poller automatically. ``data/config.json`` gains an optional
  ``runtime`` section (``spawn_watcher`` / ``spawn_poller``, default
  ``true``) so power users can disable individual children; the
  poller auto-disables when the config has neither character IDs nor
  a player name.

- **Pure-function config reader.** New
  ``SC2Replay-Analyzer/launcher_config.py`` exposes ``load_config``,
  ``read_pulse_args``, ``read_runtime_flags``, and ``build_poller_argv``.
  All four are pure (no IO once the file is read) and covered by 21
  unit tests under ``SC2Replay-Analyzer/tests/test_launcher_config.py``.
  The launcher and the standalone helper share ``build_poller_argv``
  so the PowerShell argv shape can never drift between callers.

### Changed

- **``reveal-sc2-opponent.bat`` no longer hardcodes identity.** The
  former ``SC2_CHARACTER_IDS=994428,8970877`` /
  ``SC2_PLAYER_NAME=ReSpOnSe`` / ``ACTIVE_REGIONS=us,eu,kr`` lines are
  gone; the .bat now delegates to a new Python helper
  ``reveal-sc2-opponent-main/scripts/poller_launch.py`` that reads
  ``data/config.json`` (whatever the wizard wrote) and spawns
  PowerShell with the right ``-CharacterId`` / ``-ActiveRegion`` /
  ``-PlayerName`` arguments. Fixes the long-standing problem where a
  fresh install pinged the maintainer''s Pulse IDs until the user
  manually edited the .bat.

### Fixed

- **Wizard Step 5 (Import past replays) actually imports.**
  ``WizardStepImport`` was passing only ``folders`` into the embedded
  ``SettingsImportPanel``; identities never reached
  ``pendingConfig.identities``, so ``selectedNames`` stayed empty and
  the panel''s Start button was permanently disabled. Users could
  click Continue past Step 5 with no historical import ever firing —
  the apply step''s ``start-initial-backfill`` only triggers macro
  recompute on already-imported games, not a folder walk. ``wizard-
  shell.jsx`` now passes ``selectedIdentities`` and ``battleTags``;
  ``wizard-apply-import.jsx`` threads them into ``fakePendingConfig``.
  Smoke-tested against the real first-run wizard flow with
  ``data/config.json``''s two identities.

## [1.1.0] - 2026-05-01

### Fixed

- **Eliminate the file-truncation incident root cause.** Production
  data files (`meta_database.json`, `MyOpponentHistory.json`,
  `config.json`, `custom_builds.json`, `community_sync_queue.json`,
  `import_state.json`, `session.state.json`,
  `stream-overlay-backend/public/_ov/design-tokens.json`,
  `package.json`) and their tracked siblings were being silently
  truncated by writers that did `tempfile + os.replace` /
  `tempfile + fs.renameSync` without an intervening `flush + fsync`.
  Three NTFS-specific failure modes (lazy-writer truncation,
  indent-line truncation, null-byte padding) were observed in
  `data/*.broken-*` over a 96-hour window. Fixed in five phases:
  (1) `flush + fsync` added to `scripts/macro_cli.py` and
  `scripts/buildorder_cli.py` `_save_db`; (2) Python long-tail
  writers (`core/error_logger.py`, `gui/analyzer_app.py` CSV +
  debug report, `core/custom_builds.py` binary backup,
  `core/data_store.py` backup marker) routed through
  `core.atomic_io.atomic_write_{json,text,bytes}`;
  (3) the three duplicated Node atomic-write impls
  (`_atomicWriteJsonSync` in `index.js`, `persistMetaDb`'s inline
  writer in `analyzer.js`, local `atomicWriteJson` in
  `routes/settings.js`) collapsed to thin delegators against
  `lib/atomic-fs.js`; (4) `analytics/spatial.py` cache and
  `analytics/win_probability.py` model save paths picked up
  `flush + fsync`; (5) `scripts/check_atomic_writes.py` added as a
  pre-commit / CI guard so a future regression fails the build.
  Three live data files (96 MB, 2.4 MB, 1.4 KB) recovered from
  the cleanest snapshot (`MyOpponentHistory.json` regained
  ~2,000 opponent records that the truncation had eaten); five
  secondary tracked JSONs restored from HEAD. See
  `docs/adr/0016-atomic-file-writes.md` for the rule and
  `docs/TRUNCATION_AUDIT.md` for the byte-level evidence.

### Fixed

- **Opponent widget shows real W-L when Black Book misses.** The merged
  opponent card was rendering 'first meeting' for opponents the user had
  played before whenever `MyOpponentHistory.json` was truncated mid-write,
  while the scouting card looked correct because its recent-games row reads
  `meta_database.json` directly. Backend now: (1) replaces the indent-
  specific `_attemptHistoryRepair` with a `_salvageJsonObject` salvage that
  walks `},\n` boundaries (handles both modern 4-space and legacy 15-space
  PowerShell indent), (2) wraps `readMetaDb` with the same salvage so the
  live overlay path keeps producing real numbers when meta_database is
  partially written, (3) falls back to a meta-DB-derived W-L when the
  Black Book has no entry for the opponent so opponentDetected and
  scoutingReport always agree on the record, and (4) resets the
  `lastOpponentText` dedup anchor when `opponent.txt` is cleared at
  game-end so a same-text rewrite next game still triggers a fresh emit.
  (`stream-overlay-backend/index.js`)
- **PowerShell `Write-FileAtomic` now fsyncs before rename.** The opponent
  scanner's atomic-write helper had `[System.IO.File]::WriteAllText` followed
  immediately by `Move-Item` -- on Windows NTFS that returns once the bytes
  hit the OS write cache, NOT once they're durable on disk. A kill/sleep/AV
  between rename and lazy-flush left `MyOpponentHistory.json` truncated. The
  helper now opens the temp file via `FileStream`, writes the bytes, calls
  `Flush($true)` (FlushFileBuffers, the Win32 fsync) before closing, and only
  THEN renames. Mirrors the contract used by `core/atomic_io.py` and
  `analyzer.js::persistMetaDb`. (`Reveal-Sc2Opponent.ps1`)
- **PowerShell scanner now writes to `data/MyOpponentHistory.json`.** It was
  writing to the legacy project-root path while every other component reads
  `data/`, which let the two files drift (recently played opponents wouldn't
  show up on the overlay until the next Python writer ran). The scanner now
  resolves `$HistoryFilePath` to `data/MyOpponentHistory.json` (with a
  fallback to the legacy path if `data/` doesn't exist yet).
- **One-shot data repair.** Salvaged and rewrote `data/MyOpponentHistory.json`
  (3168 entries clean, plus 10 unique entries merged in from the legacy
  copy = 3178 total, including the `FIIClicK#670` record that triggered
  this debug session). Salvaged and rewrote `data/meta_database.json` (56
  builds, 7921 games). All three files now parse cleanly via strict
  `JSON.parse`; the salvage fallback in the readers stays in place as
  defense-in-depth. Originals preserved as `.pre-repair-<ts>.bak`.



### Added

- **Windows installer (NSIS).** New `packaging/installer.nsi` plus
  orchestrator `packaging/build-installer.ps1` produce
  `dist/SC2Tools-Setup-<version>.exe`. Bundles embeddable Python 3.12,
  pre-installs every Python and Node.js dependency at build time so the
  user installer needs no PyPI / npm registry access at install time,
  defaults to a per-user install at `%LOCALAPPDATA%\Programs\SC2Tools`,
  detects Node.js 18+ on PATH, registers an HKCU uninstaller, and drops
  Start Menu + Desktop shortcuts pointing at the Stage 3 launcher.
- **Release CI.** `.github/workflows/release.yml` builds the installer
  on tag push `v*.*.*` and on manual dispatch, runs the silent install
  smoke test, and attaches the `.exe` plus `.sha256` sidecar to the
  GitHub Release.
- **ADR 0014** documents the NSIS + bundled-Python decision and the
  per-user install path choice.
- **Auto-update (Stage 12.1).** New `routes/version.js` exposes
  `GET /api/version` (1-hour cached lookup against the GitHub Releases
  API) and `POST /api/update/start` (localhost-only, same-origin,
  single-use nonce). The SPA gets an `<UpdateBanner>` at the top of
  every page that surfaces newer releases, and the existing
  Settings -> About "Check for updates" button is wired to the same
  endpoint. Helper `packaging/silent-update.ps1` waits for the backend
  to exit, downloads the new `.exe` to `%TEMP%`, verifies the published
  SHA256, runs the installer with `/S`, and relaunches via the install
  location stored in `HKCU\Software\SC2Tools`.
- **Version sync guard.** `.github/workflows/version-check.yml` asserts
  that `stream-overlay-backend/package.json` (canonical),
  `SC2Replay-Analyzer/__init__.py` `__version__`, and the SPA's
  `SETTINGS_VERSION` literal all agree on every PR. Drift breaks the
  build instead of shipping a confused About panel.
- **ADR 0015** records the auto-update architecture: version source of
  truth, cache + nonce + spawn-and-exit pattern, and the three-layer
  guard on `/api/update/start`.

### Changed

- **Pinned dependencies.** Every Python and Node.js dependency now uses
  an exact version pin. `SC2Replay-Analyzer/requirements.txt` and
  `reveal-sc2-opponent-main/requirements.txt` use `==`; the Express
  backend's `package.json` mirrors the resolved versions from
  `package-lock.json`. This is a prerequisite for reproducible
  installer builds.

### Notes

- The first installer release will be tagged separately once the
  smoke test has run on a clean Windows 11 VM.
- Users on existing manual installs at `C:\SC2TOOLS\` are not migrated
  by the installer; they can either continue running from there or
  reinstall via the `data\` across by hand.
- Auto-update is op
