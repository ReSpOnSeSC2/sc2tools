# MapReplayer rendering-core rewrite — implementation notes

Replaces the flat-icon-on-a-dimmed-map replay layer with animated,
directional 3D-rendered sprites on a full-colour terrain map at true
world scale, with tweened motion.

## Files

| File | Status |
| --- | --- |
| `apps/web/components/analyzer/game/MapReplayer.tsx` | rewritten (1109 → 1643 lines) |
| `apps/web/lib/spriteSheets.ts` | **new** — sprite registry, atlas cache, draw path |
| `apps/web/lib/replayMotion.ts` | **new** — tweening, facing, anim phase, mining cycle |
| `apps/web/lib/spriteManifest.generated.ts` | **new, generated** — baked sidecar geometry |
| `scripts/gen-sprite-manifest.mjs` | **new** — regenerates the manifest from the sidecars |
| `apps/web/lib/mapReplay.ts` | 1 change: `WORKER_UNIT_NAMES` / `TOWNHALL_NAMES` now exported |
| `apps/web/components/analyzer/game/MapReplaySection.tsx` | `maxHeightPx` prop, compact stage cap, skeleton resized |

---

## 1. The world→pixel transform, and how sprite scale derives from it

There is exactly **one** authority, unchanged from before —
`worldProjection(bounds, w, h, pad)` in `lib/mapReplay.ts`. It returns
`k` = **pixels per world unit** plus the centring offsets:

```ts
const proj = worldProjection(bounds, w, h, STAGE_PAD_PX);
const k = proj.k;
//   canvasX = proj.ox + (worldX - bounds.minX) * k
//   canvasY = proj.oy + (bounds.maxY - worldY) * k      (Y flipped)
//   spriteCellPx = worldUnitsPerCell * k
```

Everything that represents a world quantity is now sized from `k`:

| Thing | Size |
| --- | --- |
| terrain rect | `(maxX-minX) * k` × `(maxY-minY) * k` |
| sprite cell | `anim.wupc * k * SPRITE_WORLD_GAIN` |
| cluster spacing | `CLUSTER_SPACING_WORLD (0.75) * k` |
| fog reveal radius | `SIGHT_* * k * view.z` |
| resource glyphs | `1.8 / 2.3 world units * k` |
| spawn ring | `6 world units * k` |
| battle pulse | `(4.5 + 6.5·f) world units * k` |
| cull margin | `CULL_MARGIN_WORLD (21) * k` |

That is the fix for the user's core complaint. Before, every unit was
`ARMY_ICON_PX = 13` and every building `13`/`19` regardless of the map
or the unit. Now a Thor's cell is `8.1 * k` against a Marine's
`1.3 * k` — **6.23×**, verified in `geometry.test.mjs` §2 — and a
CommandCenter is `8.1 * k`, **6.2× a Marine**, with the old hard-coded
`TOWNHALL_ICON_PX` bump deleted (verified in
`motion-integration.test.mjs` §6).

`SPRITE_WORLD_GAIN` is **1.0**, i.e. geometrically exact. It exists as
a single named dial in case legibility ever has to win over fidelity;
it should not be raised casually.

`MIN_SPRITE_SCREEN_PX = 9` is a floor on the on-screen cell size,
expressed as `MIN_SPRITE_SCREEN_PX / view.z` so the ctx zoom turns it
back into a constant screen size. On a full-page stage it never binds
(a Marine at k≈7.6 is 9.9 px); it exists so the compact drilldown at
k≈3 doesn't render 4-pixel units. Above the floor, relative scale is
untouched.

### Anchors

The sidecar `anchor` is the pixel inside the cell where the model's
ground origin projects. The draw path lands that pixel on the map
coordinate:

```ts
const scale = cellPx / meta.frameSize;
const dx = x - anim.ax * scale;
const dy = y - anim.ay * scale;
```

Centring the bitmap instead would sit every sprite too low — 18.7 % of
a cell for a Marine, **32.3 % for an Archon** (measured across the
manifest in `geometry.test.mjs` §1). The test proves the drawn alpha
bounding box lands within 2 px of the analytic prediction derived from
the source cell.

`anims.Walk` carries its **own** `wupc` and `anchor` and both are
honoured — a Stalker is 3.7 standing and 4.8 walking, so using the
wrong one is a 30 % size jump on every step.

### Stage sizing

`CANVAS_MAX_H_PX = 720` is deleted. The stage is now sized like a video
player: full column width, the **map's own aspect**, capped by
`STAGE_VIEWPORT_FRACTION = 0.78` of the viewport height (or the host's
`maxHeightPx`; the compact drilldown passes 420). When the height cap
bites, the canvas *narrows* rather than letterboxing, and the wrapper
(`flex justify-center`) centres it — so every canvas pixel is playable
ground. Also re-applies on `window.resize`, not just container resize.

---

## 2. Facing convention and hysteresis

Sheet contract: *"index 0 = unit faces South (down-screen, toward the
viewer); index increases counter-clockwise on screen in 45 deg steps"*.

World Y grows **up**, canvas Y grows **down**, so screen velocity is
`(vx, -vy)`. `atan2(screenX, screenY)` is exactly the sheet's angle:
0° for `(0,+1)` = straight down-screen = South = index 0, +90° for
`(+1,0)` = East = index 2.

```ts
export function facingFromVelocity(vx: number, vy: number, prev: number): number {
  const speed = Math.hypot(vx, vy);
  if (speed < FACING_MIN_SPEED) return prev;
  const deg = (Math.atan2(vx, -vy) * 180) / Math.PI;
  const heading = ((deg % 360) + 360) % 360;
  const step = 360 / FACING_COUNT;
  if (prev >= 0 && prev < FACING_COUNT) {
    // Signed shortest angle from the current bucket's centre.
    const delta = (((heading - prev * step) % 360) + 540) % 360 - 180;
    if (Math.abs(delta) <= FACING_HYSTERESIS_DEG) return prev;
  }
  return Math.round(heading / step) % FACING_COUNT;
}
```

All eight compass cases are asserted in `motion.test.mjs` §1, and every
0.25° of heading is checked against the nearest bucket in §2.

**Hysteresis is 30°, measured from the current facing's centre** — not
28° past the boundary, which would have been 50.5° from centre and
wider than a whole 45° bucket (a slow turn could then skip a facing).
30° from centre = **7.5° past** the 22.5° boundary. Because the
neighbouring bucket is equally sticky, the dead band around a boundary
is `2·H − 45 = 15°` wide, i.e. **a heading jittering ±7.5° across a
boundary never flips** (asserted at ±7.3 = 0 flips over 2000 frames,
and at ±8.0 it does flip, as designed). Must stay below 67.5°, checked
in the test. Zero velocity holds the last facing; so does sub-threshold
jitter (`FACING_MIN_SPEED = 0.35` world units/s).

Facing state lives in an `Int8Array` in the per-payload `Derived`
record (a `WeakMap` keyed by the playback object), so it survives
frames and resets naturally when the payload changes.

Buildings pass `facings: 1` and never rotate — asserted for facing
indices `0,1,3,5,7,-2,99` producing pixel-identical output
(`geometry.test.mjs` §5).

---

## 3. Tweening

`sampleTrack()` composes three behaviours, in order:

1. **Speed-capped departure** (kept from `unitPositionAt`): hold the
   last anchor, depart at the last moment that still arrives on time at
   `unitMaxSpeed`. This is what stopped "floating probes" and it is
   preserved exactly.
2. **Clamped Catmull-Rom** over the moving part of the segment, with
   tangents taken from the *neighbouring* waypoints in real time units
   (non-uniform / Overhauser form, so unequal gaps don't produce speed
   jumps), each clamped to `TANGENT_CLAMP (0.85) × chord`.
3. **Smoothing weight** `smooth = effective/span`: tangents are blended
   toward the chord itself, so a long hold followed by a short dash
   comes out **exactly** the straight constant-speed line the old lerp
   drew, while a continuously-moving unit gets the full curve.

Bounds, all asserted numerically over 20 000 random tracks:

* deviation from the chord ≤ `(0.0962 + 0.2963·clamp)·|chord|` =
  **0.348** at clamp 0.85; measured worst case **0.263**. Nothing ever
  escaped a 3× map box.
* peak instantaneous speed ≤ **2.0×** the segment average (the maximum
  of `|d01|+|d10|+|d11|`, at u = 0.5); measured worst case 1.916. A
  realistic speed-capped dash measures **1.112×** — a gentle ease out
  of a stop. Positions still arrive on time to 1e-5.
* position is C0 across joins (max jump 1.3e-5 world units) and the
  analytic velocity matches central differences to 7e-5, which matters
  because facing is driven by that velocity.
* max per-frame step at 60 fps on a real zig-zag: 0.18 world units.

Waypoint lookup is a **binary search**, not the old linear scan
(500 units × 240 waypoints × 60 fps = 7.2 M comparisons/s → ~8 steps).

`born`/`died` clipping is unchanged (`unitAliveAt` gates the loop);
`sampleTrack` clamps before the first and after the last waypoint with
zero velocity.

---

## 4. Animation

`Walk` when `|v| > WALK_SPEED_THRESHOLD (0.45)` and the sprite has a
walk cycle, else `Stand`. Both handles are resolved **once per
payload**, so the per-frame switch is an array index; for
`noWalkSequence` sprites (Carrier, SiegeTank, Tempest) the two handles
are literally the same object.

Frames advance with **game** time, so animation tracks playback speed:

```ts
const f = Math.floor(t * rate + phase01 * frames);
return ((f % frames) + frames) % frames;
```

Measured end to end through `renderFrame`: a Marine's 3 fps Stand cycle
advances **2 / 11 / 23 / 47 frames per wall second at 1× / 4× / 8× /
16×**. `ANIM_FPS_CEILING = 60` saturates the effective rate so a 12 fps
walk at 16× (192 fps) becomes a blur rather than a strobe; 1× is always
exact and 4× is exact for any cycle up to 15 fps.

Being stateless (a pure function of `t`), scrubbing always lands on the
same frame — no accumulator to desync.

Per-unit phase is `phaseOffset(payloadIndex)`, an integer hash into
[0,1) precomputed into a `Float32Array`. 30 units at one instant occupy
all 8 distinct frames; 1200 indices produce 1038 distinct offsets. No
lockstep.

---

## 5. Worker mining cycle

`miningCycleSample()` runs a 5.2 s loop: haul to the hall (0–34 %),
dwell at the dock (34–44 %), return to the patch (44–78 %), mine
(78–100 %). Anchors are **the existing helpers, unchanged** —
`patchesNearHall` → `patchMiningPosition` (or `miningArcPosition` for
the v1 arc fallback when `resources` is empty) for the patch end, and a
dock point `HALL_DOCK_RADIUS = 2.4` world units out from the hall
centre on the patch's side for the hall end. Phase is staggered by
`phaseOffset(unitIndex)` so 24 workers on one patch occupy 18 distinct
positions at any instant. The loop is exactly periodic (2e-14) and
never overshoots the patch or enters the hall past the dock radius.

Facing falls out for free: a worker arrives at the patch moving toward
it, so it faces the patch while mining, and faces the hall while
docked.

**Deliberate refinement (flag for review):** the handover is
*feathered* rather than snapped.

```ts
const nearW = clamp01((MINING_SNAP_RADIUS - dist) / MINING_FEATHER_WORLD);
const idleW = clamp01(1 - speed / MINING_IDLE_SPEED);
const mix = nearW * idleW;
```

`MINING_SNAP_RADIUS = 12` is untouched — `mix` is exactly 0 at the
radius, so the outer boundary behaves as before. Inside it, position
and velocity lerp between the unit's own track and the cycle. Without
this, a worker *walking across its own base* would teleport onto the
mineral line and back, which the old static presentation got away with
because nothing else moved smoothly either. Asserted: a worker crossing
its base at full speed deviates 0.00 world units from its path and
never reverses; a parked worker travels the full hall↔patch trip with a
max step of 0.19 px/frame.

---

## 6. Reconciling the 60° sprite pitch with the top-down map

**Decision: draw the map top-down and the tilted sprites upright on top
of it, unmodified.** This is the same pragmatic choice the competitor
makes, and it is documented in `spriteSheets.ts` at the draw call.

The reasoning:

* The sheets are **orthographic** renders from a camera pitched 60°
  above the horizon. Within a cell, one pixel is `wupc / frameSize`
  world units in *both* image-plane axes, so a cell must be drawn
  **square** — `cellPx × cellPx`. It must not be squashed vertically.
* Ground distances *inside the sprite* are foreshortened by
  `sin(60°) = 0.866`; the map underneath is not. There is no transform
  that fixes this, because the sprite mixes ground-Y with model height
  in one axis: a 0.866 vertical squash would correct the footprint and
  simultaneously crush a Thor to two-thirds of its height.
* The alternatives were worse. Squashing the map by 0.866 to match
  would mis-scale every world coordinate against the payload's own
  bounds and distort the terrain art. Re-rendering the sheets at 90°
  pitch (true top-down) would throw away the 3D read that is the whole
  point of the exercise.
* So the sprites are treated as **billboards**: correct width, correct
  ground anchor, correct relative scale, and a foreshortened silhouette
  that reads as "a unit seen at a game-camera angle" rather than a
  literal orthographic projection of the map plane. The visible
  artefact is that a unit's *footprint* is ~13 % shallower in Y than
  the ground it stands on. At the sizes involved (a Marine is 10 px)
  this is not perceptible.

Depth sorting compensates for the rest: units and buildings go into
**one** list sorted back-to-front by ground-point screen Y, so a Marine
in front of a Barracks draws over it. That, not the projection, is what
makes the layer read as 3D.

---

## 7. Sprite cache and performance

### Strategy

* **Geometry is bundled, not fetched.** `scripts/gen-sprite-manifest.mjs`
  bakes all 103 sidecars into `spriteManifest.generated.ts` (29 KB
  source, **3.3 KB gzipped**). Geometry is needed synchronously on the
  first frame — it decides whether a name has a sprite at all, how big
  to draw it, and which raster bucket to build — so fetching 103
  sidecars would put a request waterfall in front of first paint and
  make units pop at the wrong size. The generator validates every entry
  against the quantised ladder and asserts no `(facing, frame)` pair
  can address a cell outside its grid.
* **Only `.webp` sheets are fetched**, from
  `NEXT_PUBLIC_SPRITE_BASE` (default `/sprites`), via the single
  `spriteUrl(kind, race, name, color, anim)` helper. No absolute URL
  appears anywhere. `crossOrigin = "anonymous"` is set on sheets
  (required — cells are re-rasterised through offscreen canvases, so a
  tainted sheet would taint every atlas and then the stage) **and on
  the terrain image** (the old code deliberately omitted it; export
  needs it).
* **Grid is always driven by the manifest**, never assumed 8×8. One
  rule covers every sheet: `cellIndex = facing * cols + frame`, with
  `cols = sheetW / frameSize`. Units (8×8, facings 8) and buildings
  (4×2 animated / 1×1 static, facings 1) both fall out of it. Proved by
  pixel-diffing 24 `(facing, frame)` pairs on a Zergling sheet and all
  8 frames of a 4×2 Nexus sheet against direct source-cell extractions.
* **Size-bucket atlases.** Sheets decode once into an `ImageBitmap`,
  then the whole grid is pre-scaled into a power-of-two bucket at the
  size it will actually be drawn, and the draw loop blits one small
  cell per unit. Because `frameSize` and the bucket are both powers of
  two, the ratio is an exact power of two and the downscale is a chain
  of clean 2:1 halvings — no aliasing from one 16:1 bilinear shrink.
* **Bounded.** Buckets are capped at 64 px (`MAX_BUCKET_PX`); above
  that the atlas would be a near-copy of the sheet, so the draw path
  blits the source cell directly — sharper *and* it stops an 8× zoom
  from building a 16 MB atlas per sheet. Atlases are evicted LRU
  against a 48 MB budget, and at most 2 are built per frame so a new
  unit type appearing never stalls a frame. Measured on a 64-sheet
  frame at several zooms: **73 atlases, 29.4 MB**.
* **Nothing string-y in the hot path.** Sheet resolution, anim
  fallback, and both team-colour URLs are resolved once per payload
  into a `SpriteAnimHandle`; per frame the draw path is array indices
  and property reads. Fog dedupe uses packed integer grid keys instead
  of template strings.
* **Culling before work.** A per-unit track bounding box (precomputed
  once) rejects units whose whole track is off screen before any
  interpolation; survivors are re-culled against their own sprite cell.
  `CULL_MARGIN_WORLD = 21` covers the widest cell, the mining cycle's
  excursion, and off-screen fog reveals.
* **Pooled draw list.** Entities are mutable records in a module-level
  pool; the painter's pass sorts an index array.

### Measured numbers

Harness: `/tmp/harness/perf.test.mjs`, driving the **real**
`renderFrame` against a synthetic payload with realistic shape (1200
units on 2 s-spaced tracks capped at 240 waypoints, 114 buildings, 73
resources, 6 mining bases, 40 battles) and the **real** `.webp` sheets,
on a 1280×1280 stage (7.62 px per world unit).

**Scene build** — every line of JS the browser also runs per frame:
waypoint interpolation, mining cycle, facing hysteresis, animation
selection, culling, depth sort, cache lookups. Raster calls
neutralised, 300 frames each:

| live units | mean | p50 | p95 | p99 |
| --- | --- | --- | --- | --- |
| 131 | 0.88 ms | 0.75 | 1.25 | 4.95 |
| 260 | 1.32 ms | 1.16 | 1.73 | 5.20 |
| **513** | **2.14 ms** | 1.92 | 2.80 | 3.71 |
| **1024** | **3.21 ms** | 3.15 | 4.30 | 6.89 |
| 513, zoomed 4× | 0.40 ms | 0.33 | 0.69 | 1.12 |

Culling is worth **5.3×** when zoomed in. Allocation is **31 KB/frame**
at 1024 units (almost entirely `spreadClusters`' output objects).

**Workload handed to the compositor**, per frame, 1024 live units + 84
buildings at z=1:

| | drawImage/frame | MPix/frame |
| --- | --- | --- |
| sprites | 1028 | 0.78 |
| resource glyphs | 67 | 0.01 |
| fog reveals | 783 | 3.18 |
| full-screen (terrain, fog composite) | 2 | 3.26 |
| **total** | **1880** | **7.23** |

1028 blits for ~1108 entities is **exactly one draw call per visible
entity** (the shortfall is the units with no sheet, which take the dot
path). 7.23 MPix is 4.4× stage overdraw on a 1.64 MPix stage.

Two optimisations came directly out of profiling and are worth knowing
about:

* the fog originally built a `createRadialGradient` per reveal —
  **2.5 ms/frame** of pure object churn. It now blits one cached 128 px
  falloff stamp, and renders into a buffer at `FOG_RENDER_SCALE = 0.4`
  of stage resolution (a soft gradient upscales invisibly), which cut
  the frame's largest fill by ~6×. Scene build went 6.35 → 2.14 ms.
* fog is now built and composited in **screen** space rather than scene
  space, so it stays sharp at 8× zoom (it used to blur 8×) and
  off-screen reveals are skipped.

The fog dedupe cell is a fraction of the reveal radius, not a fixed
pixel count. The fraction is bounded: two sources sharing a cell of
side `c` are at most `c·√2` apart and a kept source is fully opaque out
to `0.55·r`, so any fraction ≤ `0.55/√2 = 0.389` guarantees the union
is visually unchanged. `FOG_DEDUPE_RADIUS_FRACTION = 0.35` keeps
margin.

### Performance target: honest answer

The 500-units-at-60 fps target is **met on the CPU side with 8× margin**
(2.14 ms of a 16.7 ms budget at 513 units; 3.21 ms at 1024). The raster
side hands the compositor 1880 small `drawImage` calls and 7.2 MPix —
a workload a GPU-composited canvas2d handles in single-digit
milliseconds, but **I could not measure it here**: `@napi-rs/canvas`
rasterises on the CPU and charges ~0.7 ms for a *single* 10×10 px
`drawImage` (measured separately), three orders of magnitude off a
browser, so any end-to-end fps number from this harness would be
fiction. **End-to-end fps needs a browser profile.** See §9.

---

## 8. What was preserved, and what changed deliberately

### Preserved (verified by reading the diff and re-running the tests)

* dirty-flag rAF loop, refs so the loop never re-binds, ~4 Hz React
  throttle for the time label
* DPR-aware icon rasterisation and its power-of-two `rasterDpr`
  quantisation (now `iconDpr`, used by the fallback path and glyphs)
* pointer-capture pan, wheel zoom with `preventDefault`, two-pointer
  pinch, dblclick reset, the ±/⤢ buttons, the 1..8 zoom clamp
* fog of war: union of both sides, `FOG_ALPHA`, all four `SIGHT_*`
  constants, drawn over terrain but **under** entities so units are
  never hidden
* battle pulse markers and their `BATTLE_WINDOW_SEC` window; spawn
  rings; neutral resource glyphs with death times (`resourceAliveAt`)
* building float/land via `moves` (`buildingPositionAt`), including a
  floated hall anchoring mining at the base it landed on
* `LossPanel`, `tradeEfficiency`, morph-aware exclusion via
  `morphConsumedIndices` (exact `sd` for v4, heuristic below)
* `statsHaveWorkers()` fallback to `workerCountAt`
* `gameLength` overshoot repair for v≤2 (untouched in `mapReplay.ts`)
* `patchesNearHall` / `patchMiningPosition` / `miningArcPosition` /
  `MINING_SNAP_RADIUS`, and the v1 arc fallback when `resources` is
  empty
* `spreadClusters` cluster spreading, still seeded by payload index
* the flat team-tinted icon fallback (`iconToken`, `TINT_ALPHA`,
  `source-atop`) and the dot fallback below it
* every `aria-*` label, `role="group"`, `aria-pressed`,
  `data-testid="map-replayer"`, `data-testid="loss-panel-*"`
* module-level cache discipline (icons, glyphs, tokens, and now sheets
  and atlases)

### Changed deliberately

| Change | Why |
| --- | --- |
| `CANVAS_MAX_H_PX = 720` deleted | stage now sizes to the viewport at the map's aspect |
| `LAYOUT_VEIL` (flat 0.42 dark wash) deleted | terrain shows at full colour; contrast comes from an **edge vignette** (`VIGNETTE_ALPHA = 0.42`, starting at 0.62 of the half-diagonal) drawn outside the view transform |
| `TOWNHALL_ICON_PX` / `ARMY_ICON_PX` / `WORKER_ICON_PX` / `BUILDING_ICON_PX` deleted | all sizes now derive from `worldUnitsPerCell × k` |
| `CLUSTER_CELL_PX` / `CLUSTER_SPACING_PX` → world units | so spread is the same physical size at every stage size and zoom |
| resource glyph / spawn ring / battle pulse sizes → world units | same reason; they used to be raw canvas px |
| terrain image gets `crossOrigin="anonymous"` | untainted canvas for future screenshot/clip export |
| units + buildings depth-sorted into one list | 3D sprites need painter's order |
| mining snap → feathered blend | see §5 |
| mining workers now included in cluster spreading | they converge on a shared hall dock; the old code excluded them because their slots never moved |
| fog rendered in screen space at 0.4× scale, stamp-based | see §7 |
| waypoint lookup: linear scan → binary search | see §3 |
| `sr-only` summary added | the canvas carries no text; the same state is spelled out for screen readers |
| `WORKER_UNIT_NAMES` / `TOWNHALL_NAMES` exported from `mapReplay.ts` | were module-private `Set`s; behaviour identical, now maintainable in one place |

### Name resolution

The manifest has 103 names; the payload has more. `resolveSprite(name,
kind)` tries the exact name, then an explicit alias table (30 entries:
`SiegeTankSieged`, `VikingFighter`, `OrbitalCommandFlying`,
`LurkerMPBurrowed`, …), then strips known state suffixes
(`Burrowed`, `Flying`, `Sieged`, `Lowered`, `Uprooted`, `Rich`, `MP`).
`kind` is checked so a unit name can never resolve onto a building
sheet. Everything else — Larva, Egg, Broodling, Interceptor,
Changeling, Locust, AutoTurret, creep tumours — returns `null` and
takes the flat-icon path, then the dot. All 23 of those cases are
asserted in `geometry.test.mjs` §7.

---

## 9. Not verified without a browser — please check these

1. **End-to-end frame rate.** CPU scene build is measured and has 8×
   margin; the raster half is not measurable in Node (see §7). Profile
   a real game with a large army at 8× playback.
2. **`ImageBitmap` path.** The harness has no `createImageBitmap`, so
   it exercised the `HTMLImageElement` fallback. The bitmap branch is
   straightforward but has not run.
3. **CORS on the sprite CDN and on `/v1/map-image`.** Sheets now
   *require* permissive CORS: a 403 on the `crossOrigin` request means
   sprites silently fall back to flat icons, and the terrain image
   would vanish (it previously loaded without `crossOrigin`). Verify
   `Access-Control-Allow-Origin` on both before shipping, and confirm
   the canvas is un-tainted with `canvas.toDataURL()`.
4. **`NEXT_PUBLIC_SPRITE_BASE` and the asset layout.** The URL scheme
   is `<base>/{units|buildings}/<Race>/<Name>_<red|blue>[_Walk].webp`.
   The webp conversion was still running while I worked; confirm all
   103 × 2 colours × (1 or 2 anims) files exist under that layout.
5. **Team-colour mapping.** `me → blue`, `opp → red`. Sanity-check that
   this reads correctly against the cyan/red HUD language.
6. **Sprite legibility at true scale.** A Marine is ~10 px on a
   1280 px stage — geometrically correct, and comparable to SC2's own
   max zoom-out, but it *is* smaller than the old flat 13 px icons for
   small units. If it reads as too small, `SPRITE_WORLD_GAIN` is the
   one dial to turn; do it knowingly.
7. **Cluster-spread popping.** Spread offsets change discontinuously
   when a unit crosses a cluster cell boundary. That was invisible when
   units teleported; with smooth motion it may show as a small jitter
   in dense balls. Tuned small on purpose (cell 1.2, spacing 0.75 world
   units). If it's visible, dropping the spread entirely is now a
   defensible option — sprites at true scale already read as a crowd.
8. **Fog at 0.4× render scale.** Should be invisible on a soft
   gradient; confirm no banding on a large stage.
9. **Atlas build hitches.** 2 atlas builds per frame, each a chain of
   2:1 halvings from a 2048² sheet. Watch for a hitch the first time a
   big army appears; if it shows, drop `ATLAS_BUILDS_PER_FRAME` to 1.
10. **Memory on long sessions.** 48 MB atlas budget plus ~64 decoded
    2048² sheets (~16 MB each as `ImageBitmap` worst case). Sheets are
    never evicted — only atlases are. If a long session on a low-memory
    device is a concern, sheets need an eviction policy too.
11. **`MapReplaySection` compact mode still returns `null`** when there
    is no playback. That is deliberate existing product behaviour
    ("nothing beats noise in the drilldown") so I did not change it,
    only threaded the stage-height prop. Say the word if you wanted it
    to render something.

---

## 10. Test harnesses

Copied into `harness/` next to this file. They are not part of the app
and are not wired into CI — they are standalone Node scripts that
transpile the real sources and run them against the real `.webp`
sheets, and they are where every number above comes from. All three
assertion suites pass.

They contain absolute paths (`/tmp/rewrite`, `/tmp/tscheck`,
`/tmp/work/out`) from the container they were written in; fix those at
the top of `build.mjs` and `dom.mjs` to re-run them elsewhere. They
need `typescript` and `@napi-rs/canvas`.

| Harness | What it proves |
| --- | --- |
| `harness/motion.test.mjs` | 60 assertions on `replayMotion.ts`: facing contract, hysteresis band, curve/speed bounds over 20 000 random tracks, C0 continuity, velocity vs central differences, anim phase spread, mining cycle periodicity |
| `harness/geometry.test.mjs` | pixel-level, against the **real sheets**: anchor placement vs analytic prediction, world scale + ladder, grid cell selection for 8×8 and 4×2 and 1×1, buildings never rotate, Walk geometry, 23 name-resolution cases, atlas bounds |
| `harness/motion-integration.test.mjs` | drives the **real `renderFrame`** at 60 fps: smooth zig-zag motion, parked units, anim speed vs playback speed, the mining round trip, a worker crossing its own base, building sizes/rotation/animation, culling |
| `harness/perf.test.mjs` | the numbers in §7 |
| `harness/build.mjs`, `harness/dom.mjs` | transpile the sources to ESM; browser-shaped globals over `@napi-rs/canvas` that read sheets off disk |

`build.mjs` appends `export { renderFrame, derivedOf, entityPool,
entityCount }` to the transpiled component so the integration harness
can inspect the draw list. Nothing in the source is exported for
testing.

`npx tsc --noEmit` passes under `strict` + `noUnusedLocals` +
`noUnusedParameters` against `MapReplayer.tsx`, `MapReplaySection.tsx`,
`mapReplay.ts`, `mapReplayLosses.ts`, `replayMotion.ts`,
`spriteSheets.ts` and `spriteManifest.generated.ts` (with stubs for
`@/lib/clientApi` and the optimizer patch profiles only).

Regenerate the manifest after re-rendering sprites:

```sh
node scripts/gen-sprite-manifest.mjs \
  --units out/webp/units --buildings out/webp/buildings \
  --out apps/web/lib/spriteManifest.generated.ts
```
