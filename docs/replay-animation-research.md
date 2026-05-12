# Replay Animation in the Browser — Research

Status: research only, no code commitments
Branch: `claude/research-replay-animation-cWm8b`
Target end state: a full vespene.gg-style animated replay viewer on the web
Renderer choice: deferred until after this research informs a prototype

This document captures (a) how vespene.gg implements its browser replay viewer
(verified from their shipped JS, not marketing copy), (b) the actual state of
the sc2tools codebase today, (c) the gap between the two, and (d) a phased
path to close it. It deliberately does not pick a renderer — that choice is
parked until Phase 1 forces the issue.

---

## 1. Reference architecture: vespene.gg

Confirmed by reading `https://vespene.gg/main.js` and `/modules/replay/*.js`.

### Data plane
- **Parser**: Python `sc2reader` (1.8.x), server-side.
- **Endpoint**: `POST /api/minimap/parse` — accepts a .SC2Replay upload, returns
  a JSON event stream (positioned unit births/deaths/moves/abilities + stats
  deltas).
- **Map terrain**: ships a per-map `pnp.bin` file (pathing-and-placement grid)
  so the client can do its own A* over walkable tiles.

### Rendering plane
- **Vanilla ES modules** loaded from `main.js` — no React/Vue/Svelte framework.
  Chart.js + socket.io are the only third-party libraries.
- **2D canvas**, not WebGL. Two canvases:
  - `replay-canvas` — main playback surface
  - `replay-overview` — small overview / picture-in-picture
- `MinimapRenderer` class drives draws via `requestAnimationFrame`. Custom
  pan/zoom, edge-scrolling, hover tooltips.

### Sprite system
- **Per-unit sprite sheets** baked from the actual SC2 unit models. Layout:
  one row per `(animation, facing)`, one column per frame. 8 facings.
- Stored at `/assets/sc2-units/<race>/<UnitName>.{png,json}`.
- Two atlas backends:
  - Legacy chroma-keyed icon path (`sc2-icons.js`)
  - "New" top-down 256-cell atlas for Terran/Zerg (`sc2-new-asset-atlas.js`,
    feature-flagged by `window.__SC2TREE_NEW_ASSETS_ENABLED`)
- Team colors baked as `red`/`blue` variants. Asset pipeline lives in
  `tools/sc2-asset-pipeline/`.

### Movement interpolation (the part most easy to under-estimate)
sc2reader emits sparse, mostly-static event timestamps. Vespene fills in
positions between events on the client:
- **A* pathfinder** (`pathfinder.js`) over a walkable grid loaded from
  `pnp.bin`. Functions: `findPath`, `simplifyPath`, `waypointLengths`,
  `weightedLengths`, `interpAlongPath`, `snapToWalkable`.
- **Speed modifiers** modeled in JS: creep bonus (per-unit, ~1.3×, 1.4× for
  Locusts, 3.5/1.31 for Queens), stim (1.5× movement+attack), Medivac Ignite
  Afterburners (4.9/3.5), cliff climbers, air units bypass terrain.
- **Live blockers** stamped/cleared on the pathing grid as destructible rocks,
  collapsible watchtowers, and unbuildable doodads are placed/destroyed.

### Audio
- `AudioEngine` (~113 KB) — full Web Audio graph.
- Buses: `master, sfx, attacks, abilities, deaths, movement, ui, voice,
  music, ambience, intro`.
- Spatial: pan, distance attenuation, earshot/cull radii, zoom-based gain +
  low-pass filter (sounds farther away get filtered, not just quieter).
- Voice cap ~36, per-event rate limiter, pitch jitter, death-protection
  window, dynamics chain (sumGain → duckGain → limiter).
- Codec auto-pick webm/opus vs m4a. Game-start/end stingers preloaded via
  inline `<link rel=preload as=fetch>` to dodge an audio race condition.

### Coaching layers (rendered on top of the canvas)
Separate modules: `mistake-compass`, `macro-coach`, `combat-coach`,
`tech-timing-coach`, `scouting-coach`, `late-game-coach`, `worker-coach`,
plus `InsightsPanel`, `highlight-reel`, `ClipRecorder`, post-match summary.

### Realtime
socket.io for live audio-tuning updates from an admin panel.

---

## 2. Current sc2tools state

### Already in place (the data side is ~70% there)
- **Parser**: `sc2reader` is already a hard dependency
  (`SC2Replay-Analyzer/requirements.txt`).
- **Event extraction**: `SC2Replay-Analyzer/core/event_extractor.py` —
  buildings, unit tracks, upgrades, deaths, with canonicalized unit names and
  filters for noise (Larva, Probes, Interceptors, etc.).
- **Playback data shape**: `SC2Replay-Analyzer/core/map_playback_data.py:299`
  `build_playback_data()` returns *exactly* the shape a browser viewer needs:
  ```
  {
    map_name, game_length, bounds {x_min,x_max,y_min,y_max,starting_locations},
    me_name, opp_name, result,
    my_events, opp_events,        # buildings + deaths + abilities
    my_stats, opp_stats,           # PlayerStatsEvent samples
    my_units, opp_units,           # per-unit { waypoints: [t,x,y,t,x,y,...], born, died }
    spawn_locations,
  }
  ```
- **Map bounds**: parses MapInfo MPQ header for the playable rectangle; falls
  back to per-map JSON, then event extents. Already correct.
- **Battle/centroid math**: `detect_battle_markers`, `centroid`,
  `interp` — all headless in `map_playback_data.py`.
- **CLI bridge**: `SC2Replay-Analyzer/scripts/playback_cli.py:16` already
  emits the full playback payload as JSON to stdout. The API layer wraps
  other CLIs identically (`scripts/preview_replay_cli.py` ↔
  `/v1/public/preview-replay`).
- **Spatial heatmaps**: `analytics/spatial.py` — scipy-KDE building/proxy/
  battle heatmaps and death-zone grid, already exposed at
  `/v1/spatial/{maps,buildings,proxy,battle,death-zone,opponent-proxies}`
  (`apps/api/src/routes/spatial.js`).
- **The old Tkinter viewer** (`SC2Replay-Analyzer/ui/map_viewer.py.deprecated`)
  proves the data shape works end-to-end at 30 FPS with pan/zoom, static
  building layer, battle markers, and centroid animation.

### Not in place
- **No `/v1/playback` HTTP route** — `playback_cli` is only callable from
  shell.
- **No browser replay UI**: `apps/web/components/analyzer/BattlefieldTab.tsx`
  is misnamed — it's a maps/matchups win-rate table built on Recharts. There
  is no canvas surface anywhere in `apps/web/`.
- **No sprite assets** in the web bundle. Unit visuals don't exist client-side.
- **No client-side movement interpolation** beyond what's baked into the
  Python `interp()`. The original `map_viewer.py` comment (line 387 of the
  deprecated viewer's planning notes) explicitly says "the browser linearly
  interpolates between consecutive waypoints" — designed but never built.
- **No A* / pathfinding**: zero infrastructure. Vespene's `pnp.bin` has no
  analog here.
- **No Web Audio engine** and no audio assets.
- **All desktop UI is deprecated** (`SC2Replay-Analyzer/ui/*.deprecated`).
  This is the meaning of "Map Intel worked locally but never on the web":
  the local Tkinter implementations of both `map_intel.py` and
  `map_viewer.py` existed and worked, but were never ported to React/Next.js
  before being retired.

### Stack constraint
- Web frontend is **Next.js 14 + React 19 + Tailwind + Recharts**. Any
  renderer must live as a client component inside that app. Server runtime
  is Express (Node.js) calling Python CLIs via subprocess.

---

## 3. Gap analysis

| Subsystem | Vespene | sc2tools | Delta |
|---|---|---|---|
| Replay parse | sc2reader (Py) | sc2reader (Py) | Identical |
| Parse endpoint | `POST /api/minimap/parse` | `playback_cli.py` (no HTTP route) | Add Express route that subprocess-invokes the CLI; identical pattern to `publicReplay.js` |
| Playback data shape | Custom JSON | `build_playback_data()` returns same shape | None — already compatible |
| Bounds + starts | `pnp.bin` + map data | MapInfo header + map_bounds.json | Equivalent; we lack walk-grid |
| Walkable grid | `pnp.bin` per map | None | **Net new**: extract from MapInfo or bake via a tool |
| Renderer | 2D Canvas + RAF | None | **Net new** (deferred decision: Canvas2D vs PixiJS/WebGL) |
| Sprite atlases | Baked per-unit sheets | None | **Net new + content + licensing** |
| Team color variants | Baked `red`/`blue` | None | Falls out of the atlas pipeline |
| Movement interpolation | Linear + A* + creep/stim/boost modifiers | Linear only, server-side | **Net new** client-side; rules are well-documented |
| Audio engine | Web Audio bus graph | None | **Net new + content** |
| Sound assets | Per-unit attack/death/move/ability clips | None | **Net new + content + licensing** |
| Coaching overlays | 7 modules | Several backend equivalents (`detectors/`, `analytics/`) | Cheap to surface on top of a working canvas |
| Highlight reel / share clip | Yes | No | Phase 4 polish |
| Spatial heatmaps | Not their focus | **Already exposed at `/v1/spatial/*`** | We're ahead here |

The shape of the gap: **data plane near-parity, presentation plane zero.**

---

## 4. Risks and open questions

### High
1. **Asset licensing.** Vespene ships Blizzard-derived sprites + audio. Their
   legal posture is unclear and not a precedent we can rely on. Options:
   (a) bake our own sheets from extracted models (same risk), (b) commission
   stylized originals (cost + time), (c) ship coloured shapes only and skip
   atlases entirely (matches the deprecated Tkinter viewer). Until this is
   settled, we should design the renderer **atlas-pluggable** so the visual
   layer can swap from circles → silhouettes → fully baked sprites without
   touching the data pipeline.
2. **Walk grid extraction.** A* needs a per-map pathing grid. sc2reader can
   read the map MPQ; `pnp.bin` is vespene's own format. We'd either bake our
   own equivalent from `MapInfo`'s placement layer (one-time tool, cached per
   map name+hash) or skip A* and animate units in straight lines between
   waypoints (acceptable for v1; ugly through cliffs/ramps).
3. **Renderer choice.** Deferred — but the decision criteria are:
   - Unit count budget: at peak SC2 ~400 units on the map, each with sprite
     animation. Plain 2D canvas + spritesheet is fine at minimap scale (vespene
     proves it). PixiJS only matters if we want full-zoom 3D-ish presentation.
   - Bundle weight: PixiJS ~500 KB gzipped; Canvas2D = 0. For a tab in a
     Next.js app that's rarely the entry point, that matters.
   - Asset format: PixiJS has first-class spritesheet support
     (`Spritesheet.from(...)`); raw canvas requires hand-rolled atlas
     indexing (vespene does this in ~9 KB of code).
   - **Recommended path**: prototype in plain Canvas2D first (it's what
     vespene chose for the same problem space); only escalate to PixiJS/WebGL
     if profiling shows we're CPU-bound on per-frame draws.

### Medium
4. **Authentication scope.** vespene's `/api/minimap/parse` is public-ish.
   Our existing `/v1/public/preview-replay` is rate-limited + anonymous and
   `/v1/spatial/*` requires Clerk auth. The new `/v1/playback` route needs to
   pick a lane: public for shared link previews, authed for user uploads.
5. **Bundle code-splitting.** The replay viewer should be a separate Next.js
   route or `dynamic(() => import(...), { ssr: false })` so the canvas
   renderer + any future atlas/audio code never lands on the analyzer
   dashboard's critical path.
6. **Mobile / touch.** Vespene has an `installReplayGestureController` and
   touch-edge-scroll detection. A non-trivial chunk of code. Acceptable to
   scope-out for v1.

### Low
7. **Realtime tuning.** Vespene uses socket.io for admin-pushed audio config.
   We can defer; static config served from `/v1/playback/config` is fine.
8. **Coaching overlays.** Most of vespene's compass/macro/combat hints map
   directly to existing detectors in `SC2Replay-Analyzer/detectors/` and
   metrics in `analytics/`. This is plumbing once a viewer exists.

---

## 5. Phased roadmap to "full vespene-style"

Each phase ships independent value. The exit criteria for each phase is what
makes the next phase's renderer/asset/audio choices possible.

### Phase 0 — HTTP bridge for playback data (1–2 days)
- Add `POST /v1/playback` to `apps/api/src/routes/` mirroring `publicReplay.js`.
- Spawn `playback_cli.py extract --replay <path> --player <name>`; return JSON.
- Schema is fixed by `build_playback_data()` — no Python changes needed.
- **Exit**: a `curl` against the API returns the same JSON the deprecated
  Tkinter viewer consumed.

### Phase 1 — Static Map Intel on the web (3–5 days)
- New Next.js route, e.g. `/app/map-intel`.
- Client component renders a single `<canvas>` with:
  - Map background image (from existing `mapImage.js` route) projected into
    `bounds`.
  - One of the existing `/v1/spatial/*` heatmaps as an alpha overlay.
  - Spawn markers and bounds box.
- No animation, no time slider.
- **Exit**: the original Map Intel feature is back, on the web. This is the
  cheapest win and validates the projection math + map-image pipeline before
  we layer animation on top.

### Phase 2 — Static + animated playback (2–4 weeks)
- Same canvas, now driven by `/v1/playback` output.
- Time slider + play/pause/speed controls.
- `requestAnimationFrame` loop.
- Building layer: drop in over time as event timestamps cross the cursor.
  (This is exactly what `map_viewer.py.deprecated` already does — port the
  logic to TS.)
- Unit layer v1: coloured circles or simple sprites (silhouettes), linear
  interpolation between waypoints. No A*.
- Battle markers: re-use `detect_battle_markers` output (already in the
  payload).
- HUD: army value / minerals / vespene / food / workers strip pulled from
  `my_stats`/`opp_stats` via JS `interp()`.
- **Renderer decision lands here.** If circles-on-canvas profile fine at
  400 units × 60 FPS, stay on Canvas2D. If not, port to PixiJS.
- **Exit**: a watchable replay playback at minimap scale, no sprites or
  audio. Functional parity with the deprecated Tkinter viewer.

### Phase 3 — Sprite atlases (4–8 weeks, gated on licensing)
- Build `tools/sc2-asset-pipeline/` analogous to vespene's:
  - Extract unit model frames (8 facings × N anim frames) for legal
    units / commissioned art.
  - Bake to PNG + JSON metadata.
  - Team-color variants `red`/`blue`.
- Atlas loader module on the client: cache by canonical unit name, fall back
  to circles if missing.
- **Exit**: replay viewer shows sprite-animated units.

### Phase 4 — Client-side pathfinding + speed modifiers (2–3 weeks)
- One-time tool to bake a walkable grid per map (key by map name + hash).
- A* + `interpAlongPath` in TS, ported from vespene's `pathfinder.js` math.
- Speed modifiers table (creep / stim / Medivac boost / cliff climbers).
- Live blocker stamping for destructible rocks.
- **Exit**: units route around cliffs and ramps; creep/stim visibly affect speed.

### Phase 5 — Web Audio engine (4–6 weeks, gated on licensing)
- Per-unit attack/death/move/ability clips.
- Bus graph + spatial mixing + zoom-based gain/LPF.
- Voice cap, rate limiter, ducking, dynamics chain.
- **Exit**: vespene-parity audio.

### Phase 6 — Coaching overlays + polish
- Surface existing detectors (`detectors/cheese.py`, `analytics/macro_score.py`,
  etc.) as compass hints overlaid on the canvas.
- Highlight reel, shareable clip recorder, post-match summary.

---

## 6. Recommended next moves (no code yet — pending user direction)

1. **Decide the asset/audio licensing posture before Phase 3+.** Phases 0–2
   are unaffected and can proceed regardless. Don't sink effort into a
   sprite pipeline until the legal answer is known.
2. **Start with Phase 0 + Phase 1** as the smallest credible move. They
   validate the projection math + API plumbing and restore the Map Intel
   feature the user lost in the desktop→web migration — both before
   committing to a renderer.
3. **Keep the renderer decision deferred until end of Phase 2.** Plain
   Canvas2D is the recommended starting point on three grounds: zero bundle
   cost, vespene proves it scales for this exact use case, and we can
   profile our way into PixiJS later if it's actually needed.

---

## 7. Appendix: file references

Existing sc2tools code that already does the work:
- `SC2Replay-Analyzer/core/map_playback_data.py:299` — `build_playback_data`
- `SC2Replay-Analyzer/core/event_extractor.py` — event canonicalization
- `SC2Replay-Analyzer/analytics/spatial.py` — heatmap aggregation
- `SC2Replay-Analyzer/scripts/playback_cli.py:16` — CLI emitter
- `SC2Replay-Analyzer/ui/map_viewer.py.deprecated:1` — reference renderer
  (Tkinter, but the logic translates directly)
- `SC2Replay-Analyzer/ui/map_intel.py.deprecated:1` — reference Map Intel UI
- `apps/api/src/routes/publicReplay.js:96` — pattern for the new
  `/v1/playback` route
- `apps/api/src/routes/spatial.js:14` — heatmap endpoints already live
- `apps/api/src/routes/mapImage.js` — map background image pipeline

Vespene reference (read-only — for inspiration, not lift):
- `https://vespene.gg/main.js`
- `https://vespene.gg/modules/replay/replay.js`
- `https://vespene.gg/modules/replay/minimap-renderer.js`
- `https://vespene.gg/modules/replay/pathfinder.js`
- `https://vespene.gg/modules/replay/sc2-unit-atlas.js`
- `https://vespene.gg/modules/replay/audio/audio-engine.js`
