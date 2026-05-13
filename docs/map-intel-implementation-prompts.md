# Map Intel — Implementation Prompt Runbook

A sequenced set of AI prompts to take Map Intel from "consistently broken,
removed from the app" to a production-grade, vespene-inspired feature.

## Context for every prompt

Paste this block at the top of every prompt before the phase-specific brief.

```
Project: sc2tools (StarCraft II replay analyzer).
Repo: /home/user/sc2tools  (ReSpOnSeSC2/sc2tools)
Stack: Express API (Node.js) at apps/api/, Next.js 14 + React 19 frontend
at apps/web/, Python sc2reader-based analyzer at SC2Replay-Analyzer/.

Background — why Map Intel was removed (commit dd9ad7c, May 7 2026):
  The Map Intel UI worked but was consistently broken: heatmaps stuck
  on "no spatial extracts" even after the agent-resync flow ran.
  Root cause: the desktop agent had to parse replays locally and upload
  spatial point arrays to MongoDB under game.spatial.*. The agent state
  tracking which games had been spatial-extracted drifted; resync
  didn't reliably backfill. R2 cloud-storage support was scaffolded
  (R2DetailsStore in apps/api/src/services/gameDetailsStore.js) but
  NEVER deployed — GAME_DETAILS_STORE defaults to "mongo" and
  publicReplay.js deletes the .SC2Replay binary immediately after
  parsing. So the server has no way to re-parse on demand.

Architectural fix (vespene.gg's pattern, verified from their shipped JS):
  Parse on the server, on demand, from the .SC2Replay file itself. No
  separate "client uploads pre-extracted spatial points" step. The
  entire bug class disappears the moment the server can reach the
  replay binary.

Vespene reference URLs (read-only, for guidance only — do not vendor
their code):
  https://vespene.gg/main.js
  https://vespene.gg/modules/replay/minimap-renderer.js
  https://vespene.gg/modules/replay/pathfinder.js
  https://vespene.gg/modules/replay/sc2-unit-atlas.js

Existing pieces we can re-use:
  SC2Replay-Analyzer/scripts/spatial_cli.py             (KDE / heatmap math)
  SC2Replay-Analyzer/scripts/playback_cli.py            (per-replay event stream)
  SC2Replay-Analyzer/analytics/spatial.py               (SpatialAggregator)
  SC2Replay-Analyzer/core/map_playback_data.py          (build_playback_data)
  apps/api/src/services/spatial.js                      (already shells out to spatial_cli)
  apps/api/src/services/gameDetailsStore.js             (R2 store scaffolded)
  apps/api/src/routes/mapImage.js                       (minimap image endpoint)

Removed UI to restore (in commit dd9ad7c^):
  apps/web/components/analyzer/MapIntelTab.tsx          (~290 LoC)
  apps/web/components/analyzer/MapIntelViewer.tsx       (~654 LoC)

Operating principles for every phase:
  - Don't trust client-uploaded extracts. Parse on the server.
  - Renderer = plain HTML 2D canvas (vespene's choice). No PixiJS yet.
  - Make every layer atlas-pluggable so we can swap colour-dot fallback
    for sprite overlays later without touching data plumbing.
  - Every phase must merge to main with the feature flag OFF by
    default. Phase exit = flag flippable safely for a single internal
    user.
  - Tests required at every phase. No "we'll backfill tests later."
```

---

## Phase 0 — Replay storage foundation

**Goal**: give the API server reliable, durable access to the original
.SC2Replay binary for every game in the database. This is the blocker for
every later phase.

**Prompt**:

```
Task: stand up replay-binary storage so the API server can fetch any
user's replay on demand.

Required outcome:
  1. A storage backend is configured and reachable from the API in
     dev, staging, and prod. Backend choice is yours — recommend one
     of these and implement it; do not over-engineer:
       (a) Cloudflare R2 (the existing scaffold in
           apps/api/src/services/gameDetailsStore.js already targets
           R2; cheapest path).
       (b) Backblaze B2 (S3-compatible, cheap, and zero egress fees
           between B2 and Cloudflare).
       (c) Self-hosted MinIO behind the API (if cloud cost is
           a hard no).
  2. The desktop agent uploads the .SC2Replay BINARY (not just parsed
     extracts) to the chosen backend on every new game. Key the object
     by sha256(replay) so we get content-addressed dedup for free.
  3. A new ReplayStorageService in apps/api/src/services/ exposes:
       getReplayBlob(userId, gameId) -> Buffer | null
       getReplayBlobByHash(hash) -> Buffer | null
       putReplayBlob(userId, gameId, hash, buffer) -> void
       listExistingHashes(userId) -> Set<string>
  4. The agent-upload route accepts the binary plus a manifest
     {gameId, sha256, size}; rejects with 409 if hash already exists
     for that user (idempotent retries).
  5. Existing tests still pass. New tests cover: store roundtrip,
     dedup-on-duplicate-hash, 404-on-missing-game, and a smoke test
     that exercises the agent->API->storage handshake end-to-end with
     a fixture .SC2Replay.

Hard constraints:
  - GAME_DETAILS_STORE default stays "mongo"; the new replay-blob
    store is a separate concept with its own env var, e.g.
    REPLAY_BLOB_STORE = {none | r2 | b2 | minio}.
  - If REPLAY_BLOB_STORE=none, every later Map Intel feature must
    no-op gracefully with a clear empty state (not a 500).
  - Do NOT alter MongoDetailsStore's blob path. We keep the slim
    metadata in Mongo, and replays in object storage.
  - Migration path: write a script that, for any user with replays in
    the existing extract-only pipeline, prompts the agent to re-upload
    the .SC2Replay binaries. Don't try to retroactively re-build
    binaries we don't have.

Files to read before starting (will give you the existing patterns):
  apps/api/src/services/gameDetailsStore.js (R2DetailsStore class)
  apps/api/src/config/loader.js (env-var parsing pattern)
  apps/api/src/routes/publicReplay.js (existing .SC2Replay upload flow,
    incl. temp-file handling and size limits)
  apps/api/src/db/migrations/2026-05-08-mongo-to-r2.js (migration tone
    + safety harness to mirror)

Acceptance:
  - `curl` against the new upload route from a fixture agent payload
    succeeds and the binary is readable through ReplayStorageService.
  - `npm test` passes.
  - Documented in docs/cloud/SETUP_CLOUD.md.
```

---

## Phase 1 — Server-side on-demand spatial extraction

**Goal**: replace SpatialService's "trust the agent" data path with
"parse from storage on demand." This is the change that actually kills
the bug.

**Prompt**:

```
Task: rewire apps/api/src/services/spatial.js so heatmap layers are
computed from the original .SC2Replay file, not from agent-uploaded
game.spatial.* fields.

Required outcome:
  1. A new internal method SpatialService._extractForGame(gameId) ->
     SpatialExtract that:
       a. Looks up game metadata from Mongo (userId, sha256, map).
       b. Fetches the binary via ReplayStorageService.
       c. Shells out to SC2Replay-Analyzer/scripts/spatial_cli.py to
          produce the per-replay spatial extract (building positions,
          battle centroids, death zones, proxies). Re-use the existing
          runPythonNdjson helper (apps/api/src/services/spatial.js:6).
       d. Caches the extract result in a new Mongo collection
          `spatial_extracts` keyed by sha256(replay). TTL: none (the
          input is content-addressed; the output is stable).
  2. SpatialService.{buildings,proxy,battle,deathZone,opponentProxies}
     iterate the user's games on the map, call _extractForGame() (which
     is a cache hit for already-parsed replays), then aggregate as
     today via spatial_cli.py's KDE path.
  3. Backwards compatibility: if a game has both an uploaded
     game.spatial.* and a cached _extractForGame() result, the cached
     extract wins (server-parsed truth > agent-parsed legacy).
  4. Concurrency control: parsing the same replay twice in parallel
     coalesces to a single Python invocation per process. Use an
     in-memory promise-map keyed by sha256.
  5. Per-request fanout cap: if the user has 500 replays on a map and
     none are extracted yet, don't fire 500 parallel Python procs.
     Cap at e.g. 8 concurrent, queue the rest. Show progress
     (X of Y parsed) to the client via the response envelope.
  6. Failure mode: if a single replay fails to parse, log it,
     mark the extract document as {ok: false, error}, and SKIP that
     replay in aggregation. Don't fail the whole request.

Hard constraints:
  - Do NOT change the public route shape at /v1/spatial/*. The web
    client is contracted against the existing JSON envelope.
  - If REPLAY_BLOB_STORE=none, return the existing "no spatial
    extracts" empty response shape (so the new viewer still renders).
  - Do not run KDE in the API process; keep the shell-out to
    spatial_cli.py. KDE is CPU-heavy and we want it sandboxed.

Files to read:
  apps/api/src/services/spatial.js (existing aggregation flow)
  SC2Replay-Analyzer/analytics/spatial.py (where the bake math lives)
  SC2Replay-Analyzer/scripts/spatial_cli.py (the CLI signature)

Acceptance:
  - End-to-end test: upload a fixture replay -> hit
    GET /v1/spatial/buildings?map=X -> non-empty cells[] without any
    desktop agent involvement.
  - Cold-cache extract finishes in <3s for an average 15-min game on
    a single core.
  - Warm-cache aggregation for 50 games on a map finishes in <800ms.
  - Existing 368+ API tests pass; new tests cover: extract caching,
    concurrent dedup, partial-failure aggregation, REPLAY_BLOB_STORE=
    none graceful degradation.

After this lands, the agent's spatial-extract upload path becomes dead
code. Don't delete it yet — Phase 6 cleans it up.
```

---

## Phase 2 — Restore the Map Intel UI

**Goal**: get the removed UI back on screen, talking to the new
server-side data path. Feature-flagged.

**Prompt**:

```
Task: restore apps/web/components/analyzer/MapIntelTab.tsx and
MapIntelViewer.tsx from git (commit dd9ad7c^) and wire them to the
new server-side spatial pipeline. Strip every trace of the
"Request resync" flow — it's now meaningless.

Required outcome:
  1. Restore both files from `git show dd9ad7c^:apps/web/components/
     analyzer/<file>` verbatim, then apply the edits below.
  2. Delete the "Request resync" button, the requestRecompute()
     handler, recomputeMsg state, the post-resync 12-second polling
     effect, and all `/v1/macro/backfill/start` calls. The new server
     parses on demand; there is nothing to resync.
  3. Replace the empty-state copy from "Your agent will re-parse
     replays..." to "Parsing your replays..." with a spinner that
     polls /v1/spatial/<layer> every 2 seconds while
     response.parsing > 0, then stops the moment parsing reaches 0.
     (The envelope returns {parsing, total} from Phase 1's fanout
     progress.)
  4. Re-add the Map Intel tab to
     apps/web/components/analyzer/AnalyzerShell.tsx and the
     map-intel option to apps/web/components/analyzer/settings/
     SettingsMisc default-tab picker. Gate both behind a feature
     flag NEXT_PUBLIC_MAP_INTEL=1 so we can ship incrementally.
  5. tsc --noEmit must pass. Lint must pass. No `any` types.

Hard constraints:
  - Keep the existing visual structure (5 layer chips, summary row,
    minimap canvas, legend). Phase 3 polishes the rendering; this
    phase is "structure restored, plumbing rewired."
  - If a user has no replays on a map yet, render the existing empty
    state ("No maps yet" Card from MapIntelTab.tsx) — don't crash.
  - All API calls must go through the existing useApi() hook at
    apps/web/lib/clientApi.ts so SWR caching and dbRev invalidation
    work consistently with the rest of the analyzer.

Files to read:
  Use git: `git show dd9ad7c^ -- apps/web/components/analyzer/MapIntelTab.tsx`
  Use git: `git show dd9ad7c^ -- apps/web/components/analyzer/MapIntelViewer.tsx`
  apps/web/components/analyzer/AnalyzerShell.tsx (tab registration pattern)
  apps/web/lib/clientApi.ts (useApi hook contract)

Acceptance:
  - With NEXT_PUBLIC_MAP_INTEL=1 set, the Map Intel tab appears, lists
    the user's maps, and rendering the heatmap layers produces non-
    empty cells for at least one map (smoke).
  - With the flag unset, no Map Intel tab anywhere in the UI; no extra
    bundle weight on the rest of the analyzer.
  - Tests: a Vitest snapshot of MapIntelTab rendering 3 mock map rows,
    and a render test of MapIntelViewer with mock cells.
```

---

## Phase 3 — Vespene-grade visual polish

**Goal**: bring the heatmap viewer's chrome up to vespene's bar:
purposeful colour palette, hover tooltips with sample sizes, proper
alpha compositing, layer toggle UX, empty/loading/error states that
feel deliberate. Plain 2D canvas, no extra libraries.

**Prompt**:

```
Task: rewrite the rendering core of apps/web/components/analyzer/
MapIntelViewer.tsx as a small, focused MinimapRenderer class modelled
on vespene.gg's vanilla-JS approach, but written in TypeScript and
hosted inside the existing React component.

Required outcome:
  1. A new MinimapRenderer class at
     apps/web/components/analyzer/MinimapRenderer.ts that:
       - Takes a HTMLCanvasElement and a {bounds, mapImage, layers}
         config.
       - Implements _project(x, y) (logical map coords -> pixel coords
         inside the canvas) and _scale (zoom factor). Modelled on
         vespene's MinimapRenderer projection.
       - Renders in three layers, repainted on every requestAnimationFrame
         tick: background (map image, faint grid), heatmap (current
         layer's cells with alpha compositing), foreground (spawn
         markers, bounds rectangle, mouse-hover tooltip).
       - Owns its own RAF loop; React owns the data inputs via props.
       - Exposes setLayer(key), setCells(cells), setHoverCell(x, y),
         destroy().
  2. Layer colour ramps consciously chosen, not arbitrary:
       buildings:        viridis (green -> yellow, dense placements)
       proxy:            indigo glow (aggressive forward play)
       opponent-proxies: amber/red (threats)
       battle:           neutral white-hot
       death-zone:       diverging red->green (loss zones in red)
     Define the ramps in a new file
     apps/web/components/analyzer/heatmapColors.ts as functions
     intensity -> rgba(). Reference vespene's chroma-keyed palettes
     in their atlases (do not copy; just use as visual guidance).
  3. Hover tooltip: when the cursor is over a cell, show a small pill
     near the cursor with {layer label, cell intensity, sample count,
     wins/losses in that cell if available}. Sub-100ms hover->paint.
  4. Layer chips: animate the selected chip with a soft glow ring
     matching the layer's primary colour. Keyboard navigable (Tab +
     Enter); ARIA radiogroup semantics; touch-friendly hit targets
     (min 44x44 px on coarse-pointer devices).
  5. Loading state: shimmer the canvas with a low-alpha sweep while
     parsing > 0, with a progress pill in the corner reading e.g.
     "Parsing 12 of 47 replays..." (data from the Phase 1 envelope).
  6. Error state: replace the canvas content with a clear card-shaped
     error message + a Retry button that hits the same endpoint with
     cache-busting.

Hard constraints:
  - No new dependencies (no PixiJS, no D3, no chroma.js). Plain canvas
    2D context only. Colour ramps must be hand-rolled (10-stop LUTs
    are fine — see vespene's atlas-icon palette for sizing).
  - Renderer must keep 60fps with a 64x64 grid (~4k cells) on a
    mid-range laptop. Profile and prove it.
  - Component must dynamic-import the MinimapRenderer module via
    next/dynamic so the canvas code never ships on routes that don't
    use it.

Files to read:
  https://vespene.gg/modules/replay/minimap-renderer.js (read the
    _project/_drawCell pattern, the layered repaint, and the hover
    quadtree-or-equivalent)
  apps/web/components/analyzer/MapIntelViewer.tsx (the React shell
    that will host this)
  apps/web/components/ui/Card.tsx + Skeleton.tsx (visual consistency)

Acceptance:
  - Lighthouse performance score on the Map Intel page >= 90.
  - axe-core a11y pass: zero serious/critical violations.
  - Manual: layer toggles feel snappy; hover tooltip lags <1 frame;
    mobile viewport at 375x812 renders without horizontal scroll.
  - Unit tests for heatmapColors.ts (every layer ramp is monotonic
    in luminance) and MinimapRenderer's _project (inverse round-trip
    is identity within 1px tolerance).
```

---

## Phase 4 — Map background + projection truth

**Goal**: every layer's cells must land in the right place on every
map, regardless of map shape or non-square playable rectangles. This
is the boring math that vespene gets right and that easily looks
wrong without care.

**Prompt**:

```
Task: make heatmap projection bounds-aware and map-image-aware so
cells overlay the correct geographic spots, parity with the legacy
desktop Tkinter viewer (SC2Replay-Analyzer/ui/map_viewer.py.deprecated).

Required outcome:
  1. SpatialService.maps() already returns {bounds, hasSpatial}. Add
     a new endpoint GET /v1/spatial/map-meta?map=X returning:
       {bounds: {x_min,x_max,y_min,y_max,starting_locations},
        image: {url, naturalWidth, naturalHeight, playableRect}}
     where playableRect is the {x,y,w,h} fraction of the image that
     corresponds to the playable rectangle (most Liquipedia minimap
     images include letterboxing).
  2. Hook into the existing mapImage.js route — preserve its caching
     headers and don't refetch the image bytes; just enrich with the
     playable-rect metadata baked from MapInfo (see
     SC2Replay-Analyzer/core/map_playback_data.py:_read_mapinfo_bounds
     for the bit-pattern).
  3. MinimapRenderer (from Phase 3) now uses playableRect to project:
       imagePixel = lerp(playableRect.{x,y,w,h},
                         normalized = ((logical - bounds.min) /
                                       (bounds.max - bounds.min)))
     This replaces any "0..200 fallback" assumption and fixes the
     "everything offset to the bottom-left" bug class.
  4. Starting locations rendered as filled circles in team-colour
     ME/OPP variants, drawn with a soft outer glow.
  5. Bounds rectangle drawn at 30% alpha so the canvas reads as
     framed even on maps where the heatmap is empty.

Hard constraints:
  - Don't trust the per-map JSON in data/map_bounds.json as the only
    source. Read MapInfo from the replay MPQ first (mirrors what the
    Python loader does), then fall back to the JSON, then to event
    extents (this is the existing chain in bounds_for()).
  - playableRect must be stored once per map in a Mongo collection
    `map_meta` so we don't recompute it per request. Invalidate on
    map_bounds.json edits.

Files to read:
  SC2Replay-Analyzer/core/map_playback_data.py:49 (_read_mapinfo_bounds)
  SC2Replay-Analyzer/ui/map_viewer.py.deprecated (the canonical
    projection / pan / zoom impl; port the math, not the Tk code)
  apps/api/src/routes/mapImage.js (caching contract)

Acceptance:
  - On 5 randomly-chosen maps, verified manually that:
      - The bounds rectangle overlays the playable area, not the full
        image including borders.
      - Spawn markers sit on top of the actual base locations.
      - Building heatmap cells land on bases / expansions / not
        in unplayable terrain.
  - Unit tests for the projection function with golden inputs from
    map_bounds.json fixtures.
```

---

## Phase 5 — Performance, caching, and code-splitting

**Goal**: Map Intel is fast on cold load, faster on warm, never adds
weight to other analyzer pages, and never re-parses the same replay
on the server twice.

**Prompt**:

```
Task: take Map Intel from "functional" to "production-grade fast."

Required outcome:
  1. Server-side aggregate cache:
       New Mongo collection `spatial_aggregates` keyed by
         (userId, mapName, layer, filtersHash).
       TTL = none. Invalidate on:
         - new game upload (the agent's existing post-game hook)
         - explicit DELETE of any game (admin path)
         - filter changes are NOT invalidations — they're new cache
           keys.
       Cache hit returns the precomputed cells[] in <50ms.
  2. ETags on every /v1/spatial/* response:
       ETag = sha1(JSON.stringify(cells)).
       Honour If-None-Match and return 304s.
  3. HTTP cache headers:
       Map metadata: Cache-Control: public, max-age=86400, immutable
         (varies by mapName + map_bounds.json content hash).
       Heatmap cells: Cache-Control: private, max-age=300,
         stale-while-revalidate=900.
  4. Client-side bundle weight:
       MinimapRenderer.ts must dynamic-import via next/dynamic with
       ssr: false. The Map Intel route's first-load JS must be <60 KB
       gzipped excluding the Next.js runtime.
       Run `pnpm next build && pnpm next analyze` (or equivalent) and
       paste the analyzer output in the PR.
  5. Optional: a background worker that pre-aggregates the user's
     most-played 3 maps when their session starts. If the architecture
     doesn't support workers cheaply, skip this and document the
     trade-off.

Hard constraints:
  - Do NOT add Redis. Use Mongo for the aggregate cache. We pick our
    battles — if the latency budget can't be hit, revisit Redis later.
  - The 5-minute private cache must respect Clerk userId; never let
    a CDN cache one user's heatmap for another.
  - When REPLAY_BLOB_STORE=none, fall through to a fast empty-state
    response without touching the cache layer.

Files to read:
  apps/api/src/services/spatial.js (Phase 1 implementation)
  apps/api/src/util/parseQuery.js (filter normalisation — must be
    deterministic for filtersHash to be stable)

Acceptance:
  - p95 latency for /v1/spatial/buildings on a warm cache: <100ms.
  - p95 latency on a cold cache for a user with 50 games on a map:
    <2.5s.
  - The Map Intel page's first-load JS (per Next analyzer): <60 KB
    gzipped excluding runtime.
  - Tests cover: aggregate cache hit, aggregate cache miss-then-fill,
    ETag 304 short-circuit, invalidation on new-game upload.
```

---

## Phase 6 — Cleanup and removal of dead code paths

**Goal**: with the new pipeline proven, retire the agent-side spatial-
extract upload, retire the Request resync UX everywhere, and shrink
the surface area so the next engineer has less to misunderstand.

**Prompt**:

```
Task: remove the legacy agent-driven spatial-extract pipeline now
that server-side parsing is the source of truth.

Required outcome:
  1. Desktop agent (reveal-sc2-opponent-main/): stop computing or
     uploading spatial.* arrays. Bump the agent version. Document the
     breaking change in CHANGELOG.md.
  2. API: remove all code paths that read game.spatial.*. Audit
     apps/api/src/services/spatial.js and any aggregations.js routes.
     Replace with extract-from-storage everywhere.
  3. Mongo migration: a script that drops the spatial.* fields from
     existing game documents in batches of 10k, with progress logging.
     Idempotent. Reversible (the field is now unused).
  4. Remove the /v1/macro/backfill/start "force resync for spatial"
     code path. If macro-backfill is still useful for other reasons,
     keep it but remove the map_intel_request_resync reason and any
     map-intel-specific branches.
  5. Delete the now-unused agent state-tracking files (the
     path_by_game_id index, if it exists only for spatial).

Hard constraints:
  - Run the migration against a snapshot of prod data first; capture
    before/after row counts and post in the PR.
  - Keep a feature flag escape hatch (READ_LEGACY_SPATIAL=1) for one
    release so we can roll back if Phase 1's cache mass-fails.
  - Document the architecture change in
    docs/adr/0019-server-side-spatial-extraction.md (new ADR).

Acceptance:
  - `grep -rn "game.spatial\|game\.spatial" apps/api/src` returns
    nothing except the migration script.
  - The agent no longer mentions "spatial" in its build logs.
  - Mongo storage usage for the games collection drops by the
    documented delta.
```

---

## Phase 7 — Observability, rate limits, and a/b rollout

**Goal**: ship to real users safely with the right telemetry and
guardrails.

**Prompt**:

```
Task: make the production rollout of Map Intel safe and measurable.

Required outcome:
  1. Structured logs (Pino or whatever the API already uses) for:
       spatial.extract.start/finish/fail  {gameId, sha256, ms, kbParsed}
       spatial.cache.hit/miss             {userId, map, layer}
       spatial.aggregate.start/finish     {userId, map, layer, n_games}
     Each log line includes correlationId from the incoming request.
  2. Metrics surfaced to the existing /v1/health or admin dashboard:
       extract_latency_p50_p95_p99
       cache_hit_rate (aggregate + per-replay)
       parse_failure_rate
       replay_blob_store_unavailable_count
  3. Rate limiting: a per-user 60-req-per-minute limit on /v1/spatial/*
     so a malicious or buggy client can't fork-bomb spatial_cli.py.
     Re-use the existing rate-limit middleware (search the codebase).
  4. Sentry / error reporter integration: any spatial.extract.fail
     above a count-threshold per hour triggers a Sentry issue with
     gameId tags so an engineer can pull the replay and reproduce.
  5. Rollout plan: ship with the existing NEXT_PUBLIC_MAP_INTEL flag
     OFF by default; enable for an internal Clerk org first; then
     10% of users via a Clerk metadata field; then 100% after 1
     week clean.

Hard constraints:
  - No PII in logs. userId is fine; usernames and player names are
    not (we already canonicalize names — keep them out of structured
    log payloads).
  - Sentry quota awareness: failure events must be sampled
    (e.g. 10% sample rate above 100/hour) so we don't burn the
    quota on a known bad replay.

Files to read:
  apps/api/src/middleware/* (find existing rate limit + correlation
    ID middleware)
  apps/api/src/routes/health.js (add metrics gauge format)

Acceptance:
  - The rollout plan is documented in
    docs/cloud/MAP_INTEL_ROLLOUT.md.
  - Internal-org dogfood for 3 days produces zero unresolved Sentry
    issues.
  - The on-call runbook for "Map Intel returns 500s" is one page
    and starts with "check spatial.extract.fail rate."
```

---

## Phase 8 — Stretch: bring the local-only goodies back

**Goal** (optional, ship-after-1.0): port the Tkinter viewer's
extras — battle markers timeline, death-zone diverging heatmap with
per-cell stats, opponent-proxy heat with player labels — that the
deprecated `map_intel.py` had but never made it to the web.

**Prompt**:

```
Task: feature-parity with SC2Replay-Analyzer/ui/map_intel.py.deprecated.

Required outcome:
  1. Death-zone layer renders with a diverging RdYlGn_r ramp anchored
     at zero (negative = my army value lost > opponent's; positive
     = the inverse). Per-cell hover shows {n_battles, mean_diff,
     median_diff}.
  2. Opponent-proxy layer hover shows {opponent name, count} so the
     user knows WHO proxies them here, not just that someone does.
  3. A new "Battles" timeline strip under the canvas showing the
     detected battle markers (detect_battle_markers output) as a
     scrubbable bar. Click a marker to flash the corresponding cell.

Files to read:
  SC2Replay-Analyzer/ui/map_intel.py.deprecated (visual reference)
  SC2Replay-Analyzer/core/map_playback_data.py:218
    (detect_battle_markers — already produces the timeline data)

Acceptance:
  - Side-by-side screenshot review with the deprecated Tkinter view:
    same information surfaced; web version has the affordances
    (hover, click-to-flash) the desktop couldn't ship.
```

---

## How to use this runbook

- Each phase is a self-contained AI prompt. Paste the **Context for
  every prompt** block first, then the phase's **Prompt** block.
- Run phases sequentially. A later phase assumes the previous one
  shipped, with the feature flag at the documented state.
- Each phase produces a single PR. Open as draft, merge after the
  acceptance checklist is green, and only then start the next phase.
- If a phase's acceptance criteria slip, do not start the next phase.
  Map Intel was killed once by accepting "almost works" — don't do
  that again.

## Renderer decision (still deferred)

Phase 3 picks plain 2D canvas, matching vespene. If a future
animated-playback feature (the full vespene-style viewer covered in
`docs/replay-animation-research.md`) outgrows canvas, the
MinimapRenderer class is isolated enough to swap to PixiJS without
touching the data plumbing.
