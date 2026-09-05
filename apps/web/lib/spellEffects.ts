/**
 * spellEffects — procedural spell / ability effects for the map replay.
 *
 * The playback payload (v5) carries a flat list of ability casts:
 * ``{ o: 0|1, a: "PsiStorm", t: 312.4, x?: 84.2, y?: 61.9 }``. This
 * module turns that list into the storms, EMPs, biles, chrono auras and
 * beams you see on the map, and nothing else — no React, no payload
 * parsing, no ownership of the render loop. ``MapReplayer`` calls
 * ``drawSpellEffects`` twice per frame (once under the units, once over
 * them) and is otherwise unaware this file exists.
 *
 * Five rules the whole file obeys:
 *
 * 1. **Everything is a pure function of ``(cast, now)``.** No spawn-on-
 *    time-crossing, no particle pools that accumulate, no wall-clock.
 *    The user scrubs backwards constantly and playback runs at up to
 *    16×; the only way both work is if frame content depends solely on
 *    the game-second being displayed. A consequence worth stating: the
 *    host's dirty-check ("redraw only when the scrub time / assets /
 *    view changed") stays *correct* with this layer added, because a
 *    paused replay at a fixed ``t`` genuinely has a static effect layer.
 *    See ``spellEffectsVersion`` for the one thing that can change
 *    without ``t`` changing.
 *
 * 2. **Every length is in SC2 world units, multiplied by ``k``.**
 *    ``k`` is pixels per world unit from ``worldProjection``. A Psi
 *    Storm is 1.5 world units of radius on every map, at every stage
 *    size, at every zoom. The only pixel quantities in this file are
 *    line widths (divided by ``view.z`` so they are constant on
 *    *screen*, exactly like the existing spawn rings and battle pulses).
 *
 * 3. **No ``createRadialGradient`` in the frame.** Soft discs are
 *    cached 128 px stamps built once per (colour, profile) and blitted
 *    — the same fix the fog compositing already made, for the same
 *    reason (a gradient per effect per frame was 2.5 ms/frame there).
 *
 * 4. **Absent ``casts`` costs nothing.** The large majority of stored
 *    games are v4 and will never have a cast list; ``drawSpellEffects``
 *    returns on its first line for those.
 *
 * 5. **The table below is the tuning surface.** Radius, timing, colour,
 *    z-layer and primitive for every ability live in one screen of
 *    data. Adding an ability is one row. Nobody should have to read the
 *    drawing code to retune a storm.
 */

import {
  buildingAliveAt,
  buildingPositionAt,
  projectX,
  projectY,
  unitVisibleAt,
  unitNameAt,
  unitMaxSpeed,
  type MapPlayback,
  type PlaybackBounds,
  type ReplayObservedEffect,
} from "@/lib/mapReplay";
import { motionSample, phaseOffset, sampleTrack, type MotionSample } from "@/lib/replayMotion";

/* ════════════════════════════════════════════════════════════════════
 *  1. THE EFFECT TABLE
 * ════════════════════════════════════════════════════════════════════ */

/** The eight draw primitives. Forty abilities, eight renderers. */
export type SpellPrim =
  /** crackling disc — purple disc + animated lightning arcs (Psi Storm) */
  | "crackle"
  /** expanding ring — a shock front that grows and fades (EMP, Nova) */
  | "ring"
  /** persistent field — tinted disc with a moving edge (Fungal, Time Warp) */
  | "field"
  /** impact splat — a wet decal that spreads then dries (Bile, Caustic Spray) */
  | "splat"
  /** unit-attached pulse — concentric rings on a unit (Stim, Blink) */
  | "pulse"
  /** entity-attached aura — rotating arcs around a structure (Chrono Boost) */
  | "aura"
  /** beam / link — caster → target line with a bright target end (Yamato) */
  | "beam"
  /** scan sweep — big soft radius with a radar wedge (Scan, Revelation) */
  | "sweep";

/** Where the effect sits relative to the depth-sorted entity pass. */
export type SpellLayer = "ground" | "overlay";

/** What a cast with no ``x``/``y`` may be pinned to, and what a
 * following effect tracks. ``"none"`` = the cast is dropped when it has
 * no coordinates; we never draw at (0,0) or at the map corner. */
export type SpellAnchor = "none" | "unit" | "building";

/** What is drawn during the lead-in, before the effect lands. */
export type SpellTelegraph =
  /** shrinking dashed reticle on the target (Nuke's dot, Stasis Ward) */
  | "reticle"
  /** a projectile arcing in from off-anchor (Corrosive Bile, Nova) */
  | "arc"
  /** a brightening beam from the caster (Yamato, Snipe) */
  | "charge";

export interface SpellEffectSpec {
  /** Draw primitive. */
  prim: SpellPrim;
  /** Effect radius in **SC2 world units**. Multiplied by ``k``
   * (pixels per world unit) at draw time — never a pixel count. */
  r: number;
  /** Seconds from the recorded order to the impact. The telegraph is
   * drawn during ``[t, t+lead)``, always on the overlay layer (it is in
   * the air); the effect itself starts at ``t+lead``. 0 = instant. */
  lead: number;
  /** Seconds the effect persists after impact. Total live window is
   * ``[t, t + lead + life]``. */
  life: number;
  /** Canonical colour, or ``null`` to take the owner tint (cyan =
   * streamer, red = opponent). */
  color: string | null;
  /** Peak alpha, before the layer-wide alpha cap. */
  alpha: number;
  /** Ground decal (under the units) or overlay (over them). */
  z: SpellLayer;
  /** Anchor kind for missing coordinates and for following. */
  anchor: SpellAnchor;
  /** Caster types, documented for the effect catalogue. Entity placement
   * uses recorded IDs exclusively; this list never selects a host. */
  from?: readonly string[];
  /** Track the anchor entity while the effect lives, instead of sitting
   * at a frozen point. Only sensible for short unit-local effects. */
  follow?: boolean;
  /** Telegraph style; only read when ``lead > 0``. Default "reticle". */
  tg?: SpellTelegraph;
  /** Fade in / out overrides, in game seconds. Defaults come from the
   * primitive: impacts bang in, fields breathe in. */
  fi?: number;
  fo?: number;
}

/* Anchor name sets, shared by several rows. */
const PROTOSS_PROD = ["Nexus", "Gateway", "WarpGate", "RoboticsFacility", "Stargate"] as const;
const ORBITAL = ["OrbitalCommand", "OrbitalCommandFlying"] as const;
const TEMPLAR = ["HighTemplar"] as const;
const GHOST = ["Ghost"] as const;
const RAVAGER = ["Ravager"] as const;
const INFESTOR = ["Infestor"] as const;
const VIPER = ["Viper"] as const;
const ORACLE = ["Oracle"] as const;
const PHOENIX = ["Phoenix"] as const;
const SENTRY = ["Sentry"] as const;
const RAVEN = ["Raven"] as const;
const BATTLECRUISER = ["Battlecruiser"] as const;
const CORRUPTOR = ["Corruptor"] as const;
const MOTHERSHIP = ["Mothership", "MothershipCore"] as const;
const BIO = ["Marine", "Marauder", "Ghost", "Reaper"] as const;
const BURROWERS = [
  "Zergling", "Roach", "Baneling", "Hydralisk", "Infestor", "SwarmHost",
  "Ultralisk", "Queen", "Drone", "LurkerMP", "WidowMine",
] as const;
const BLINKERS = ["Stalker", "Adept", "DarkTemplar"] as const;

/** Canonical spell colours. Kept out of the table rows so a row is one
 * readable line, and so a palette tweak is one edit. */
const PSIONIC = "#a874ff";      // Psi Storm, Feedback — Protoss psionics
const EMP_BLUE = "#bfe4ff";     // EMP, Interference Matrix — cold static
const CREEP_GREEN = "#79cf4a";  // Fungal Growth, Infested Terran
const ACID = "#c3e63a";         // Corrosive Bile, Caustic Spray
const VIPER_TEAL = "#57c9b0";   // Abduct, Blinding Cloud, Parasitic Bomb
const WARP_VIOLET = "#8a8cff";  // Time Warp, Mass Recall, Purification Nova
const SHIELD_GOLD = "#ffd88a";  // Guardian Shield, Force Field, Stasis Ward
const SCAN_WHITE = "#ffeeb8";   // Scanner Sweep, Revelation
const FIRE = "#ff9b3d";         // Yamato, Nuke, Widow Mine, Tac Jump
const NEURAL_PINK = "#ff6fd0";  // Neural Parasite, Contaminate
const LIFT_CYAN = "#7fe8ff";    // Graviton Beam, Pulsar Beam, Lockdown

/**
 * ┌──────────────────────────────────────────────────────────────────┐
 * │  THE EFFECT TABLE — the tuning surface.                          │
 * │                                                                  │
 * │  r     radius in SC2 WORLD UNITS (a Marine's sprite cell is 1.3) │
 * │  lead  seconds order → impact (telegraph window)                 │
 * │  life  seconds impact → gone                                     │
 * │  color null = owner-tinted (cyan = you, red = opponent)          │
 * │  alpha peak alpha, before the layer-wide cap                     │
 * │  z     "ground" = under units · "overlay" = over units           │
 * │  anchor/from  what a cast with no x/y pins to ("none" = skip)    │
 * │  follow  effect tracks its anchor instead of a frozen point      │
 * │                                                                  │
 * │  Radii are the real SC2 values where the ability has one         │
 * │  (Psi Storm 1.5, Fungal 2.25, Guardian Shield 4.5, Scan 13);     │
 * │  deviations for legibility are called out inline.                │
 * │  Counts are casts seen in a 96-replay production sample.         │
 * └──────────────────────────────────────────────────────────────────┘
 */
export const SPELL_EFFECTS: Readonly<Record<string, SpellEffectSpec>> = {
  /* ── Protoss ─────────────────────────────────────────────────────── */
  // 1168 casts — 40% of everything. Short life on purpose: the real
  // buff is 20 s, but at ~1 cast/s late game that is 20 overlapping
  // auras and a permanently speckled base. 6 s reads as "this just got
  // boosted" without swamping. This is the dial to turn if you disagree.
  ChronoBoost:      { prim: "aura",    r: 2.6,  lead: 0,    life: 6,   color: null,        alpha: 0.55, z: "ground",  anchor: "building", from: PROTOSS_PROD, follow: true },
  Blink:            { prim: "pulse",   r: 2.0,  lead: 0,    life: 0.9, color: null,        alpha: 0.75, z: "overlay", anchor: "unit",     from: BLINKERS },
  ForceField:       { prim: "field",   r: 1.4,  lead: 0,    life: 11,  color: SHIELD_GOLD, alpha: 0.5,  z: "ground",  anchor: "none",     from: SENTRY },
  GuardianShield:   { prim: "field",   r: 4.5,  lead: 0,    life: 15,  color: SHIELD_GOLD, alpha: 0.32, z: "ground",  anchor: "unit",     from: SENTRY, follow: true },
  PulsarBeam:       { prim: "pulse",   r: 2.2,  lead: 0,    life: 3,   color: null,        alpha: 0.6,  z: "overlay", anchor: "unit",     from: ORACLE, follow: true },
  StasisWard:       { prim: "field",   r: 2.5,  lead: 0.5,  life: 6,   color: SHIELD_GOLD, alpha: 0.45, z: "ground",  anchor: "none",     from: ORACLE, tg: "reticle" },
  Revelation:       { prim: "sweep",   r: 6,    lead: 0,    life: 12,  color: SCAN_WHITE,  alpha: 0.4,  z: "ground",  anchor: "none",     from: ORACLE },
  PsiStorm:         { prim: "crackle", r: 1.5,  lead: 0,    life: 4,   color: PSIONIC,     alpha: 0.7,  z: "overlay", anchor: "none",     from: TEMPLAR },
  Feedback:         { prim: "pulse",   r: 1.8,  lead: 0,    life: 0.8, color: PSIONIC,     alpha: 0.8,  z: "overlay", anchor: "none",     from: TEMPLAR },
  TimeWarp:         { prim: "field",   r: 3.5,  lead: 0,    life: 10,  color: WARP_VIOLET, alpha: 0.42, z: "ground",  anchor: "none",     from: MOTHERSHIP },
  PurificationNova: { prim: "ring",    r: 1.5,  lead: 0.9,  life: 1,   color: WARP_VIOLET, alpha: 0.8,  z: "overlay", anchor: "none",     from: ["Disruptor"], tg: "arc" },
  MassRecall:       { prim: "field",   r: 6.5,  lead: 0,    life: 2.5, color: WARP_VIOLET, alpha: 0.5,  z: "ground",  anchor: "none",     from: MOTHERSHIP },
  GravitonBeam:     { prim: "beam",    r: 1.3,  lead: 0,    life: 4,   color: LIFT_CYAN,   alpha: 0.6,  z: "overlay", anchor: "unit",     from: PHOENIX },
  Charge:           { prim: "pulse",   r: 1.7,  lead: 0,    life: 1,   color: null,        alpha: 0.6,  z: "overlay", anchor: "unit",     from: ["Zealot"] },

  /* ── Terran ──────────────────────────────────────────────────────── */
  CalldownMULE:     { prim: "aura",    r: 2.4,  lead: 0.6,  life: 2.5, color: null,        alpha: 0.6,  z: "ground",  anchor: "building", from: ORBITAL, tg: "arc" },
  Stim:             { prim: "pulse",   r: 1.8,  lead: 0,    life: 1.2, color: null,        alpha: 0.65, z: "overlay", anchor: "unit",     from: BIO, follow: true },
  ScannerSweep:     { prim: "sweep",   r: 13,   lead: 0,    life: 12,  color: SCAN_WHITE,  alpha: 0.35, z: "ground",  anchor: "none",     from: ORBITAL },
  SupplyDrop:       { prim: "aura",    r: 2.4,  lead: 0.6,  life: 2.5, color: null,        alpha: 0.6,  z: "ground",  anchor: "building", from: ORBITAL, tg: "arc" },
  EMP:              { prim: "ring",    r: 1.5,  lead: 0,    life: 1.2, color: EMP_BLUE,    alpha: 0.85, z: "overlay", anchor: "none",     from: GHOST },
  Snipe:            { prim: "beam",    r: 1,    lead: 1.4,  life: 0.6, color: EMP_BLUE,    alpha: 0.8,  z: "overlay", anchor: "unit",     from: GHOST, tg: "charge" },
  // Nuke: 14 s of dot before 8 world units of very loud.
  Nuke:             { prim: "ring",    r: 8,    lead: 14,   life: 3.5, color: FIRE,        alpha: 0.9,  z: "overlay", anchor: "none",     from: GHOST, tg: "reticle" },
  Yamato:           { prim: "beam",    r: 1.6,  lead: 2,    life: 1.2, color: FIRE,        alpha: 0.85, z: "overlay", anchor: "unit",     from: BATTLECRUISER, tg: "charge" },
  TacticalJump:     { prim: "ring",    r: 3,    lead: 0,    life: 2,   color: null,        alpha: 0.7,  z: "overlay", anchor: "none",     from: BATTLECRUISER },
  InterferenceMatrix:{prim: "beam",    r: 1.4,  lead: 0,    life: 5,   color: EMP_BLUE,    alpha: 0.6,  z: "overlay", anchor: "unit",     from: RAVEN },
  AntiArmorMissile: { prim: "ring",    r: 3,    lead: 1.2,  life: 1.5, color: FIRE,        alpha: 0.7,  z: "overlay", anchor: "none",     from: RAVEN, tg: "arc" },
  WidowMineDetonate:{ prim: "ring",    r: 1.75, lead: 0,    life: 1,   color: FIRE,        alpha: 0.85, z: "overlay", anchor: "none",     from: ["WidowMine"] },
  Lockdown:         { prim: "beam",    r: 1.3,  lead: 0,    life: 4,   color: LIFT_CYAN,   alpha: 0.6,  z: "overlay", anchor: "unit",     from: GHOST },
  Salvage:          { prim: "aura",    r: 2,    lead: 0,    life: 1.5, color: null,        alpha: 0.5,  z: "ground",  anchor: "building", from: ["Bunker"] },

  /* ── Zerg ────────────────────────────────────────────────────────── */
  Burrow:           { prim: "pulse",   r: 1.6,  lead: 0,    life: 1,   color: null,        alpha: 0.5,  z: "ground",  anchor: "unit",     from: BURROWERS },
  Unburrow:         { prim: "pulse",   r: 1.6,  lead: 0,    life: 1,   color: null,        alpha: 0.5,  z: "ground",  anchor: "unit",     from: BURROWERS },
  SpawnChangeling:  { prim: "pulse",   r: 1.5,  lead: 0,    life: 1.2, color: null,        alpha: 0.5,  z: "overlay", anchor: "unit",     from: ["Overseer"], follow: true },
  // Bile lands ~2 s after the order — the whole point of the lead-in.
  CorrosiveBile:    { prim: "splat",   r: 1,    lead: 2,    life: 1.2, color: ACID,        alpha: 0.8,  z: "ground",  anchor: "none",     from: RAVAGER, tg: "arc" },
  ParasiticBomb:    { prim: "field",   r: 3,    lead: 0,    life: 7,   color: VIPER_TEAL,  alpha: 0.5,  z: "overlay", anchor: "none",     from: VIPER },
  CausticSpray:     { prim: "beam",    r: 1.5,  lead: 0,    life: 2.5, color: ACID,        alpha: 0.6,  z: "overlay", anchor: "unit",     from: CORRUPTOR },
  Abduct:           { prim: "beam",    r: 1.2,  lead: 0.6,  life: 1,   color: VIPER_TEAL,  alpha: 0.8,  z: "overlay", anchor: "unit",     from: VIPER, tg: "charge" },
  FungalGrowth:     { prim: "field",   r: 2.25, lead: 0,    life: 4,   color: CREEP_GREEN, alpha: 0.55, z: "ground",  anchor: "none",     from: INFESTOR },
  BlindingCloud:    { prim: "field",   r: 2,    lead: 0,    life: 11,  color: VIPER_TEAL,  alpha: 0.45, z: "ground",  anchor: "none",     from: VIPER },
  NeuralParasite:   { prim: "beam",    r: 1.3,  lead: 0,    life: 6,   color: NEURAL_PINK, alpha: 0.6,  z: "overlay", anchor: "unit",     from: INFESTOR },
  // Targets an ENEMY structure, so the caster's side tells us nothing
  // about where it landed: anchor "none", drawn only when placed.
  Contaminate:      { prim: "aura",    r: 2.6,  lead: 0,    life: 12,  color: NEURAL_PINK, alpha: 0.45, z: "ground",  anchor: "none" },
  InfestedTerran:   { prim: "pulse",   r: 1.5,  lead: 0,    life: 2,   color: CREEP_GREEN, alpha: 0.55, z: "overlay", anchor: "none",     from: INFESTOR },
  Transfusion:      { prim: "pulse",   r: 1.8,  lead: 0,    life: 1.3, color: CREEP_GREEN, alpha: 0.75, z: "overlay", anchor: "none",     from: ["Queen"] },
  SpawnLarva:       { prim: "aura",    r: 2.6,  lead: 0,    life: 2,   color: CREEP_GREEN, alpha: 0.5,  z: "ground",  anchor: "none",     from: ["Queen"] },
};

/**
 * Anything the engine emits that is not in the table above. Drawn only
 * when the cast carries real coordinates — a small owner-tinted ping,
 * so a newly-mapped ability shows *something* rather than nothing, and
 * never invents a position. Set to ``null`` to drop unknown slugs.
 */
const UNKNOWN_EFFECT: SpellEffectSpec | null = {
  prim: "pulse", r: 1.5, lead: 0, life: 1, color: null, alpha: 0.35,
  z: "overlay", anchor: "none",
};

/* ════════════════════════════════════════════════════════════════════
 *  2. LAYER-WIDE POLICY
 * ════════════════════════════════════════════════════════════════════ */

/**
 * Master switch. Flip this constant to ship the layer off; call
 * ``setSpellEffectsEnabled`` to bind it to a UI toggle at runtime (that
 * path bumps ``spellEffectsVersion`` so the host's dirty-check
 * repaints).
 */
export const SPELL_EFFECTS_ENABLED = true;

/**
 * Global gain on every effect radius. 1.0 is geometrically exact: the
 * table's radii are the real SC2 values, so a Psi Storm is 1.5 world
 * units at every stage size and zoom. Exists as one named dial in case
 * legibility ever has to win over fidelity — the same escape hatch, and
 * the same warning, as the sprite layer's ``SPRITE_WORLD_GAIN``.
 */
const EFFECT_WORLD_GAIN = 1.0;
/**
 * Floor on an effect's on-SCREEN radius, in CSS px, so the compact
 * drilldown (k ≈ 3) does not draw a Stim pulse four pixels across.
 * Deliberately below the point where it binds on a full-size stage: at
 * k ≥ 3.4 even the smallest row (r = 1) clears it untouched, so relative
 * scale is exact everywhere it matters. Mirrors the component's own
 * ``MIN_SPRITE_SCREEN_PX`` / ``MIN_FURNITURE_SCREEN_PX``.
 */
const MIN_EFFECT_SCREEN_PX = 5;
/**
 * Ceiling on the SUM of all live effect alphas. Effects are additive
 * light on a dark map; without a cap, a late-game Protoss base with
 * eight chrono auras and a storm turns the terrain into soup. When the
 * sum exceeds this, every effect is scaled down by the same factor —
 * relative emphasis is preserved, total ink is not.
 */
const MAX_LAYER_ALPHA = 2.2;
/** Hard cap on simultaneously drawn effects; the most recent win. */
const MAX_ACTIVE_EFFECTS = 48;
/** Lightning re-rolls per game second. Quantising to a tick is what
 * makes the crackle deterministic under scrubbing. */
const CRACKLE_HZ = 14;
/** Resolution of the cached soft-disc stamps. Same reasoning as the fog
 * mask: the falloff is a ratio, so one canvas serves every radius. */
const STAMP_PX = 128;
/** Owner tint, mirroring MapReplayer's ME_ARMY / OPP_ARMY. Duplicated
 * rather than imported because the component does not export them and
 * this module must not depend on the component. */
const OWNER_COLOR = ["#3ec0c7", "#e05656", "#bbc6d6"] as const;

let enabled: boolean = SPELL_EFFECTS_ENABLED;
/**
 * Bumped whenever something OTHER than the scrub time changes what this
 * layer draws — today only the enable toggle and a stamp cache reset.
 * The host folds it into its dirty flag exactly the way it already
 * folds ``spriteAssetsVersion()``, so a paused replay repaints once
 * when the layer is switched on or off and then goes quiet again.
 *
 * It deliberately does NOT tick while effects are live: effect
 * appearance is a pure function of the game second being displayed, so
 * a paused replay's effect layer is genuinely static and re-rendering
 * it every frame would burn battery for an identical image. While
 * PLAYING, the host is already unconditionally dirty.
 */
let version = 0;

export function spellEffectsVersion(): number {
  return version;
}

export function spellEffectsEnabled(): boolean {
  return enabled;
}

export function setSpellEffectsEnabled(on: boolean): void {
  if (on !== enabled) {
    enabled = on;
    version += 1;
  }
}

/* ════════════════════════════════════════════════════════════════════
 *  3. PER-PAYLOAD DERIVED DATA
 *
 *  Built once per playback object and cached on a WeakMap, exactly like
 *  the component's own ``derivedOf``. Three jobs:
 *    • drop casts we can never place (no coordinates, no host);
 *    • resolve each remaining cast's host entity ONCE, so the frame
 *      loop never searches units by name;
 *    • sort by cast time so the active window is a binary search.
 * ════════════════════════════════════════════════════════════════════ */

interface EntityRef { index: number; building: boolean }

interface CastTable {
  /** Cast times, ascending. The binary search runs on this. */
  t: Float64Array;
  /** ``lead + life`` per cast — how long after ``t`` it stays live. */
  span: Float64Array;
  /** Longest span in this payload; the search window's width. */
  maxSpan: number;
  spec: SpellEffectSpec[];
  owner: Uint8Array;
  /** Impact point, world units. Valid once ``state`` is 1. */
  x: Float64Array;
  y: Float64Array;
  /** Host entity index, or -1. Positive = index into ``units`` when
   * ``hostIsBuilding`` is 0, into ``buildings`` when it is 1. */
  host: Array<EntityRef | null>;
  caster: Array<EntityRef | null>;
  casterId: Array<number | string | undefined>;
  cx: Float64Array;
  cy: Float64Array;
  /** Placement state: 0 = not resolved yet, 1 = placed, 2 = no honest
   * position exists, skip forever. See ``ensureResolved``. */
  state: Uint8Array;
  /** Index into the ORIGINAL ``playback.casts`` array — the identity
   * the crackle/arc hashes are seeded from, and what the harness
   * compares a naive filter against. */
  src: Int32Array;
  observed: Int32Array;
  n: number;
  /** ``owner|name`` → entity indices, built on first use. Only payloads
   * that actually need a host pay for them. */
  entities: Map<string, EntityRef[]> | null;
}

const castCache = new WeakMap<MapPlayback, CastTable | null>();

/** Cheap ``owner|name`` → indices index, so host resolution is a map
 * lookup and a short scan instead of a pass over 1200 units per cast. */
const FOLLOW_TARGET = new Set([
  "ChronoBoost", "GravitonBeam", "Snipe", "Yamato", "InterferenceMatrix",
  "Lockdown", "ParasiticBomb", "CausticSpray", "Abduct", "NeuralParasite",
  "Contaminate", "Transfusion", "SpawnLarva", "SupplyDrop",
]);
const SELF_EFFECTS = new Set([
  "Stim", "Burrow", "Unburrow", "GuardianShield", "PulsarBeam", "SpawnChangeling", "Salvage",
]);

const buildSample: MotionSample = motionSample();

/** Stable SC2 raw effect IDs. The engine's observed radius/lifetime wins
 * over the command catalogue's illustrative timings. */
const OBSERVED_SLUGS: Readonly<Record<number, string>> = {
  1: "PsiStorm", 2: "GuardianShield", 3: "TimeWarp", 4: "TimeWarp",
  5: "ThermalLance", 6: "ScannerSweep", 7: "Nuke",
  8: "LiberatorZone", 9: "LiberatorZone", 10: "BlindingCloud",
  11: "CorrosiveBile", 12: "LurkerSpines",
};
const OBSERVED_COMMAND_SLUGS = new Set(Object.values(OBSERVED_SLUGS));

function observedSlug(effect: ReplayObservedEffect): string {
  return OBSERVED_SLUGS[effect.id] ?? effect.name;
}

function observedSpec(effect: ReplayObservedEffect): SpellEffectSpec {
  const slug = observedSlug(effect);
  const base = SPELL_EFFECTS[slug] ?? UNKNOWN_EFFECT!;
  return {
    ...base,
    // A live raw effect is already present. Never predict its impact.
    prim: effect.id === 7 ? "pulse" : effect.id === 11 ? "field" : base.prim,
    // Bile CP is the observed target marker, visible above the units or
    // buildings it threatens; it is not a predicted ground impact.
    z: effect.id === 11 ? "overlay" : base.z,
    r: effect.radius, lead: 0, life: effect.end - effect.t,
    fi: 0, fo: 0, follow: false, anchor: "none",
  };
}

function buildCastTable(playback: MapPlayback): CastTable | null {
  const casts = playback.casts ?? [];
  const observed = playback.effects ?? [];
  if (!casts.length && !observed.length) return null;
  const entries: Array<{
    t: number; span: number; spec: SpellEffectSpec; owner: number;
    src: number; observed: number; casterId?: number | string;
  }> = [];
  const observedBySlug = new Map<string, ReplayObservedEffect[]>();
  for (let oi = 0; oi < observed.length; oi += 1) {
    const e = observed[oi];
    if (![e.t, e.end, e.x, e.y, e.radius].every(Number.isFinite) || e.end <= e.t) continue;
    const s = observedSpec(e);
    entries.push({ t: e.t, span: s.life, spec: s, owner: e.owner === "neutral" ? 2 : e.owner === "opp" ? 1 : 0, src: -1 - oi, observed: oi });
    const slug = observedSlug(e);
    const bucket = observedBySlug.get(slug) ?? [];
    bucket.push(e);
    observedBySlug.set(slug, bucket);
  }
  for (let si = 0; si < casts.length; si += 1) {
    const c = casts[si];
    if (!Number.isFinite(c.t)) continue;
    const known = SPELL_EFFECTS[c.a];
    const s = known ?? UNKNOWN_EFFECT;
    if (!s || (!known && !Number.isFinite(c.x))) continue;
    // Complete engine observations also prove the absence of a raw effect:
    // a failed Storm order must not become a predicted Storm animation.
    if (playback.fidelity?.effects === "observed" && playback.fidelity.complete === true &&
        OBSERVED_COMMAND_SLUGS.has(c.a)) continue;
    // Partial/legacy enrichment suppresses a command only when a matching
    // effect is actually observed nearby during that command's window.
    const matches = observedBySlug.get(c.a);
    if (matches?.some(e => e.owner === (c.o === 1 ? "opp" : "me") &&
        e.t >= c.t - 0.25 && e.t <= c.t + s.lead + s.life &&
        Number.isFinite(c.x) && Number.isFinite(c.y) &&
        Math.hypot(e.x - c.x!, e.y - c.y!) <= Math.max(1, e.radius))) continue;
    const ids = c.casterUnitIds?.length ? c.casterUnitIds : [c.casterUnitId];
    for (const id of ids) {
      entries.push({ t: c.t, span: s.lead + s.life, spec: s, owner: c.o,
        src: si, observed: -1, casterId: id });
    }
  }
  entries.sort((a, b) => a.t - b.t);
  const n = entries.length;
  if (!n) return null;
  return {
    t: Float64Array.from(entries, e => e.t),
    span: Float64Array.from(entries, e => e.span),
    maxSpan: entries.reduce((max, e) => Math.max(max, e.span), 0),
    spec: entries.map(e => e.spec),
    owner: Uint8Array.from(entries, e => e.owner),
    src: Int32Array.from(entries, e => e.src),
    observed: Int32Array.from(entries, e => e.observed),
    casterId: entries.map(e => e.casterId),
    x: new Float64Array(n), y: new Float64Array(n),
    cx: new Float64Array(n).fill(NaN), cy: new Float64Array(n).fill(NaN),
    host: new Array(n).fill(null), caster: new Array(n).fill(null),
    state: new Uint8Array(n), n, entities: null,
  };
}

/**
 * Place cast ``i``: work out where its effect happens and, if the row
 * needs one, which entity hosts it. Returns false when no honest
 * position exists, in which case the cast is marked and never
 * reconsidered.
 *
 * **Lazy on purpose.** Resolution scans candidate entities by name and
 * samples their tracks at the cast's own time; doing all of it up front
 * cost ~25 ms on a 3 000-cast payload, i.e. a visible hitch on the
 * frame the replay first paints. Doing it on first activation spreads
 * the same total across the playthrough — a few casts per frame at 16×
 * — and a payload the viewer never scrubs into never pays at all.
 *
 * It stays scrub-safe because resolution is a pure function of the
 * payload and the CAST's time (never of ``now``): it is memoised, not
 * accumulated, so the answer is the same whichever frame asks first.
 */
function entityPosition(
  playback: MapPlayback, ref: EntityRef, t: number, out: MotionSample,
): MotionSample | null {
  if (ref.building) {
    const b = playback.buildings[ref.index];
    if (!buildingAliveAt(b, t)) return null;
    const p = b.moves.length ? buildingPositionAt(b, t) : b;
    out.x = p.x;
    out.y = p.y;
    out.vx = 0;
    out.vy = 0;
    return out;
  }
  const u = playback.units[ref.index];
  return unitVisibleAt(u, t) ? sampleTrack(u.wp, t, unitMaxSpeed(unitNameAt(u, t)), out) : null;
}

/** Exact tag lookup, including identities that morph between unit/building. */
function resolveEntity(
  table: CastTable, playback: MapPlayback, id: number | string | undefined,
  t: number, owner?: 0 | 1,
): EntityRef | null {
  if (id === undefined) return null;
  if (!table.entities) {
    table.entities = new Map();
    for (const building of [false, true]) {
      const list = building ? playback.buildings : playback.units;
      for (let index = 0; index < list.length; index += 1) {
        const tag = list[index].id;
        if (tag === undefined) continue;
        const refs = table.entities.get(String(tag)) ?? [];
        refs.push({ index, building });
        table.entities.set(String(tag), refs);
      }
    }
  }
  for (const ref of table.entities.get(String(id)) ?? []) {
    const item = ref.building ? playback.buildings[ref.index] : playback.units[ref.index];
    if (owner !== undefined && item.owner !== (owner === 1 ? "opp" : "me")) continue;
    if (entityPosition(playback, ref, t, buildSample)) return ref;
  }
  return null;
}

/** No position/identity means unplaceable. Old payloads keep located markers. */
function ensureResolved(table: CastTable, i: number, playback: MapPlayback): boolean {
  if (table.state[i] !== 0) return table.state[i] === 1;
  const observed = table.observed[i];
  if (observed >= 0) {
    const effect = playback.effects![observed];
    table.x[i] = effect.x;
    table.y[i] = effect.y;
    table.state[i] = 1;
    return true;
  }
  const c = playback.casts?.[table.src[i]];
  if (!c) return false;
  const s = table.spec[i];
  const hasXY = Number.isFinite(c.x) && Number.isFinite(c.y);
  const caster = resolveEntity(table, playback, table.casterId[i], c.t, c.o);
  const target = resolveEntity(table, playback, c.targetUnitId, c.t);
  table.caster[i] = caster;
  if (caster) {
    const p = entityPosition(playback, caster, c.t, buildSample);
    if (p) { table.cx[i] = p.x; table.cy[i] = p.y; }
  }
  let px = hasXY ? c.x as number : NaN;
  let py = hasXY ? c.y as number : NaN;
  if (target && FOLLOW_TARGET.has(c.a)) {
    table.host[i] = target;
  } else if (c.targetUnitId === undefined && caster && SELF_EFFECTS.has(c.a)) {
    table.host[i] = caster;
  }
  if (!hasXY) {
    const anchor = target ?? (SELF_EFFECTS.has(c.a) ? caster : null);
    const p = anchor ? entityPosition(playback, anchor, c.t, buildSample) : null;
    if (p) { px = p.x; py = p.y; }
  }
  if (!Number.isFinite(px) || !Number.isFinite(py)) {
    table.state[i] = 2;
    return false;
  }
  table.x[i] = px;
  table.y[i] = py;
  table.state[i] = 1;
  return true;
}

function castsOf(playback: MapPlayback): CastTable | null {
  let table = castCache.get(playback);
  if (table === undefined) {
    table = buildCastTable(playback);
    castCache.set(playback, table);
  }
  return table;
}

/* ════════════════════════════════════════════════════════════════════
 *  4. THE ACTIVE WINDOW
 * ════════════════════════════════════════════════════════════════════ */

/** First index with ``t[i] >= v``. Plain lower-bound binary search. */
function lowerBound(arr: Float64Array, n: number, v: number): number {
  let lo = 0;
  let hi = n;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (arr[mid] < v) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

/**
 * Indices (into the ORIGINAL ``playback.casts``) of every cast whose
 * live window contains ``now``, ascending by cast time, written into
 * ``out``; returns the count. This is the pure TIME window: uncapped,
 * and before placement — the drawing pass then drops the casts it
 * cannot place, culls off-screen, and caps.
 *
 * The window is ``[t, t + lead + life]``. ``lead`` runs FORWARD from
 * the recorded time because the payload records the *order*, not the
 * impact: a Corrosive Bile ordered at t lands at t+2, a Nuke at t+14.
 *
 * A cast can only be live if it started within ``maxSpan`` seconds, so
 * one binary search for ``now - maxSpan`` bounds the scan; the forward
 * walk stops at the first cast that has not happened yet. Cost is
 * O(log n + casts started in the last maxSpan seconds) instead of O(n).
 */
export function activeCastIndices(
  playback: MapPlayback,
  now: number,
  out: number[],
): number {
  const table = castsOf(playback);
  if (!table) return 0;
  let count = 0;
  for (let i = lowerBound(table.t, table.n, now - table.maxSpan); i < table.n; i += 1) {
    const ct = table.t[i];
    if (ct > now) break;
    if (ct + table.span[i] < now) continue;
    if (table.src[i] < 0 || (count > 0 && out[count - 1] === table.src[i])) continue;
    out[count] = table.src[i];
    count += 1;
  }
  return count;
}

/** One live effect, resolved for a specific game second. Pooled. */
export interface ActiveSpellEffect {
  spec: SpellEffectSpec;
  /** Index into ``playback.casts``. */
  src: number;
  /** Engine observations use a negative src; commands retain their index. */
  source: "command" | "observation";
  owner: 0 | 1 | 2;
  /** Effect centre in world units (the host's LIVE position when the
   * spec follows, the frozen impact point otherwise). */
  wx: number;
  wy: number;
  /** Caster position in world units, or NaN — the origin of a beam and
   * of a telegraph arc. */
  cx: number;
  cy: number;
  /** Seconds since the order. */
  age: number;
  /** Telegraph progress in [0,1), or -1 once the effect has landed. */
  tel: number;
  /** Post-impact progress in [0,1], or -1 while still in the air. */
  p: number;
  /** Envelope alpha AFTER the layer-wide cap. Zero outside the window. */
  alpha: number;
  /** Base and highlight colour for this owner. */
  color: string;
  colorHi: string;
}

const activePool: ActiveSpellEffect[] = [];
/** Indices of the live window, between the two passes of
 * ``activeSpellEffects``. Module-level so a frame allocates nothing. */
const windowScratch: number[] = [];
let activeCount = 0;
/** The active set only depends on (payload, game second, enabled), so
 * the ground pass computes it and the overlay pass reuses it. */
let activeKey: MapPlayback | null = null;
let activeTime = Number.NaN;
let activeVersion = -1;

const drawSampleA: MotionSample = motionSample();

function pushActive(): ActiveSpellEffect {
  let e = activePool[activeCount];
  if (!e) {
    e = {
      spec: UNKNOWN_EFFECT as SpellEffectSpec, src: 0, source: "command", owner: 0,
      wx: 0, wy: 0, cx: NaN, cy: NaN, age: 0, tel: -1, p: -1,
      alpha: 0, color: "#fff", colorHi: "#fff",
    };
    activePool[activeCount] = e;
  }
  activeCount += 1;
  return e;
}

/** Default fade-in, seconds. Impacts bang, fields breathe.
 *
 * An effect that was TELEGRAPHED lands at full alpha: it already had a
 * lead-in, and fading it up would put a dip at the exact instant of
 * impact — the one frame the viewer is looking at. */
function fadeIn(s: SpellEffectSpec): number {
  if (s.fi !== undefined) return s.fi;
  if (s.lead > 0) return 0;
  const bang = s.prim === "ring" || s.prim === "splat" || s.prim === "crackle" || s.prim === "pulse";
  return bang ? 0.1 : Math.min(0.35, s.life * 0.25);
}

/** Default fade-out, seconds. Nothing ever vanishes on one frame. */
function fadeOut(s: SpellEffectSpec): number {
  if (s.fo !== undefined) return s.fo;
  const bang = s.prim === "ring" || s.prim === "splat" || s.prim === "crackle" || s.prim === "pulse";
  return bang ? Math.min(0.5, s.life * 0.55) : Math.min(0.9, s.life * 0.3);
}

/**
 * Envelope alpha for an effect ``age`` seconds after its order.
 * Exactly 0 outside ``[0, lead + life]``, so an effect is never
 * on-screen one frame and gone the next.
 */
export function spellEnvelope(s: SpellEffectSpec, age: number): number {
  if (age < 0 || age > s.lead + s.life) return 0;
  if (age < s.lead) {
    // Telegraph: dimmer than the effect, brightening as it closes in.
    const q = s.lead > 0 ? age / s.lead : 1;
    return s.alpha * (0.3 + 0.35 * q) * clamp01(age / 0.2);
  }
  const t = age - s.lead;
  const fi = fadeIn(s);
  const fo = fadeOut(s);
  const up = fi > 0 ? clamp01(t / fi) : 1;
  const down = fo > 0 ? clamp01((s.life - t) / fo) : 1;
  return s.alpha * up * down;
}

/**
 * Resolve every effect live at ``now`` into the pooled active list.
 * Pure in ``(playback, now)``; the result is memoised so the two draw
 * passes share one computation.
 *
 * The returned records are POOLED — read them before the next call.
 */
export function activeSpellEffects(
  playback: MapPlayback,
  now: number,
): { list: ReadonlyArray<ActiveSpellEffect>; count: number } {
  if (playback === activeKey && now === activeTime && version === activeVersion) {
    return { list: activePool, count: activeCount };
  }
  activeKey = playback;
  activeTime = now;
  activeVersion = version;
  activeCount = 0;
  const table = enabled ? castsOf(playback) : null;
  if (!table) return { list: activePool, count: 0 };

  // Pass 1 — the live, placeable window, in cast order.
  let live = 0;
  for (let i = lowerBound(table.t, table.n, now - table.maxSpan); i < table.n; i += 1) {
    const ct = table.t[i];
    if (ct > now) break;
    const age = now - ct;
    const s = table.spec[i];
    if (age > s.lead + s.life) continue;
    if (table.observed[i] >= 0 && age >= s.life) continue;
    if (spellEnvelope(s, age) <= 0) continue;
    if (!ensureResolved(table, i, playback)) continue;
    windowScratch[live] = i;
    live += 1;
  }
  // Cap: when a fight produces more live effects than the cap, keep the
  // most RECENT ones — the ones the viewer is watching happen.
  const first = live > MAX_ACTIVE_EFFECTS ? live - MAX_ACTIVE_EFFECTS : 0;

  // Pass 2 — resolve each survivor for this exact game second.
  let alphaSum = 0;
  for (let w = first; w < live; w += 1) {
    const i = windowScratch[w];
    const age = now - table.t[i];
    const s = table.spec[i];
    const a = spellEnvelope(s, age);

    const e = pushActive();
    e.spec = s;
    e.src = table.src[i];
    e.source = table.observed[i] >= 0 ? "observation" : "command";
    e.owner = table.owner[i] === 2 ? 2 : table.owner[i] === 1 ? 1 : 0;
    e.age = age;
    e.tel = age < s.lead ? (s.lead > 0 ? age / s.lead : 0) : -1;
    e.p = age >= s.lead ? (s.life > 0 ? (age - s.lead) / s.life : 1) : -1;
    e.alpha = a;
    e.color = s.color ?? OWNER_COLOR[e.owner];
    e.colorHi = highlight(e.color);
    e.wx = table.x[i];
    e.wy = table.y[i];
    e.cx = NaN;
    e.cy = NaN;

    // Target and caster are distinct identities. A Chrono aura rides
    // its target; a Yamato beam starts at the recorded caster.
    const host = table.host[i];
    if (host) {
      const p = entityPosition(playback, host, now, drawSampleA);
      if (!p) {
        activeCount -= 1;
        continue;
      }
      if (s.follow === true || FOLLOW_TARGET.has(playback.casts![e.src].a)) {
        e.wx = p.x;
        e.wy = p.y;
      }
    }
    e.cx = table.cx[i];
    e.cy = table.cy[i];
    const caster = table.caster[i];
    if (caster && (s.prim === "beam" || s.tg === "charge")) {
      const p = entityPosition(playback, caster, now, drawSampleA);
      e.cx = p?.x ?? NaN;
      e.cy = p?.y ?? NaN;
    }
    alphaSum += a;
  }

  // Layer-wide alpha cap: scale everything by one factor so relative
  // emphasis survives but the map does not disappear under light.
  if (alphaSum > MAX_LAYER_ALPHA) {
    const scale = MAX_LAYER_ALPHA / alphaSum;
    for (let i = 0; i < activeCount; i += 1) activePool[i].alpha *= scale;
  }
  return { list: activePool, count: activeCount };
}

/* ════════════════════════════════════════════════════════════════════
 *  5. CACHED STAMPS
 *
 *  One 128 px canvas per (colour, profile), built once, blitted at
 *  whatever radius each effect needs. The fog layer learned this the
 *  hard way: a createRadialGradient per source per frame cost 2.5 ms.
 * ════════════════════════════════════════════════════════════════════ */

type StampKind = "glow" | "core" | "edge";

const stampCache = new Map<string, HTMLCanvasElement | null>();

function stamp(color: string, kind: StampKind): HTMLCanvasElement | null {
  const key = `${color}|${kind}`;
  const hit = stampCache.get(key);
  if (hit !== undefined) return hit;
  if (typeof document === "undefined") {
    stampCache.set(key, null);
    return null;
  }
  const c = document.createElement("canvas");
  c.width = STAMP_PX;
  c.height = STAMP_PX;
  const g = c.getContext("2d");
  if (!g) {
    stampCache.set(key, null);
    return null;
  }
  const r = STAMP_PX / 2;
  const grad = g.createRadialGradient(r, r, 0, r, r, r);
  const rgb = rgbOf(color);
  const at = (stop: number, a: number) =>
    grad.addColorStop(stop, `rgba(${rgb[0]},${rgb[1]},${rgb[2]},${a})`);
  if (kind === "glow") {
    // Soft bloom: bright core melting into nothing. Beams' target ends,
    // auras, sweeps.
    at(0, 1);
    at(0.35, 0.5);
    at(0.72, 0.14);
    at(1, 0);
  } else if (kind === "core") {
    // A body with an edge: flat out to 0.62 then a quick falloff. This
    // is what makes a Fungal read as an area and not a smudge.
    at(0, 1);
    at(0.62, 0.92);
    at(0.86, 0.4);
    at(1, 0);
  } else {
    // A soft annulus — a shock front with thickness, used where a
    // 1-pixel stroke would alias at low zoom.
    at(0, 0);
    at(0.55, 0.05);
    at(0.82, 1);
    at(1, 0);
  }
  g.fillStyle = grad;
  g.fillRect(0, 0, STAMP_PX, STAMP_PX);
  stampCache.set(key, c);
  return c;
}

const rgbCache = new Map<string, [number, number, number]>();

function rgbOf(hex: string): [number, number, number] {
  const hit = rgbCache.get(hex);
  if (hit) return hit;
  const h = hex.replace("#", "");
  const v = parseInt(h.length === 3 ? h.replace(/./g, (c) => c + c) : h, 16);
  const out: [number, number, number] = [(v >> 16) & 255, (v >> 8) & 255, v & 255];
  rgbCache.set(hex, out);
  return out;
}

const hiCache = new Map<string, string>();

/** A lighter sibling of a colour, for arcs, rims and hot cores.
 * Computed once per colour, so nothing builds strings per frame. */
function highlight(hex: string): string {
  const hit = hiCache.get(hex);
  if (hit) return hit;
  const [r, g, b] = rgbOf(hex);
  const mix = (c: number) => Math.round(c + (255 - c) * 0.55);
  const out = `#${((1 << 24) | (mix(r) << 16) | (mix(g) << 8) | mix(b)).toString(16).slice(1)}`;
  hiCache.set(hex, out);
  return out;
}

/* ════════════════════════════════════════════════════════════════════
 *  6. DRAWING
 * ════════════════════════════════════════════════════════════════════ */

interface Proj {
  k: number;
  ox: number;
  oy: number;
}

interface ViewTransform {
  z: number;
  ox: number;
  oy: number;
}

/** Frame-local draw context, so primitives take one argument. */
interface DrawCtx {
  g: CanvasRenderingContext2D;
  bounds: PlaybackBounds;
  proj: Proj;
  /** Pixels per world unit — THE scale. */
  k: number;
  /** Divisor that turns a screen-pixel line width into scene units. */
  z: number;
  /** Smallest radius, in WORLD units, that still clears
   * ``MIN_EFFECT_SCREEN_PX`` on screen this frame. */
  minR: number;
  now: number;
}

const dc: DrawCtx = {
  g: null as unknown as CanvasRenderingContext2D,
  bounds: { minX: 0, minY: 0, maxX: 1, maxY: 1 },
  proj: { k: 1, ox: 0, oy: 0 },
  k: 1,
  z: 1,
  minR: 0,
  now: 0,
};

/** Shared dash pattern — allocated once; setLineDash copies it. */
const FIELD_DASH = [6, 5];
const NO_DASH: number[] = [];

/**
 * Draw one z-layer of the spell effect layer.
 *
 * Called twice per frame from ``MapReplayer.renderFrame``, INSIDE the
 * view transform (so coordinates are scene pixels and line widths are
 * divided by ``view.z``):
 *
 *   • ``"ground"`` immediately before the depth-sorted entity pass, so
 *     fields, splats, sweeps and structure auras lie on the terrain and
 *     units walk over them;
 *   • ``"overlay"`` immediately after it, so storms, beams, shock rings
 *     and every telegraph read over the sprites they are happening to.
 *
 * Returns the number of effects drawn (0 on a v4 payload, always).
 */
export function drawSpellEffects(
  ctx: CanvasRenderingContext2D,
  playback: MapPlayback,
  now: number,
  proj: Proj,
  view: ViewTransform,
  w: number,
  h: number,
  layer: SpellLayer,
): number {
  // v4 and older: no casts, no work, no behaviour change. This is the
  // hot path for the majority of stored games.
  if (!enabled || (!playback.casts?.length && !playback.effects?.length)) return 0;
  const { list, count } = activeSpellEffects(playback, now);
  if (count === 0) return 0;

  // Visible scene rect, matching renderFrame's own cull rect: a scene
  // point p is drawn at ox + p*z, so the visible range is
  // [-ox/z, (w-ox)/z].
  const cullX0 = -view.ox / view.z;
  const cullY0 = -view.oy / view.z;
  const cullX1 = cullX0 + w / view.z;
  const cullY1 = cullY0 + h / view.z;

  dc.g = ctx;
  dc.bounds = playback.bounds;
  dc.proj = proj;
  dc.k = proj.k;
  dc.z = view.z;
  // The floor is a SCREEN size, so it shrinks in world units as the
  // stage grows or the user zooms in — exactly like the component's
  // sprite floor, which is expressed as MIN_SPRITE_SCREEN_PX / view.z.
  dc.minR = MIN_EFFECT_SCREEN_PX / view.z / proj.k;
  dc.now = now;

  const ground = layer === "ground";
  let drawn = 0;
  ctx.save();
  ctx.lineCap = "round";
  for (let i = 0; i < count; i += 1) {
    const e = list[i];
    const s = e.spec;
    const telegraphing = e.tel >= 0;
    // Telegraphs are always overlay: a bile in flight and a nuke dot
    // are in the air, above everything, whatever their impact's layer.
    if (telegraphing ? ground : ground !== (s.z === "ground")) continue;

    const sx = projectX(dc.bounds, proj, e.wx);
    const sy = projectY(dc.bounds, proj, e.wy);
    // Observed extents are game data. A readability floor is appropriate
    // for command cues, but must not enlarge a recorded area of effect.
    const R = e.source === "observation" ? s.r : radiusOf(s);
    // Cull off-screen. The margin covers a telegraph arc's apex and a
    // beam reaching in from a caster outside the effect's own radius.
    const margin = Math.max(R * 3, 12) * dc.k;
    if (sx + margin < cullX0 || sx - margin > cullX1) continue;
    if (sy + margin < cullY0 || sy - margin > cullY1) continue;

    if (telegraphing) drawTelegraph(e, sx, sy, R);
    else {
      drawPrim(e, sx, sy, R);
      if (e.source === "observation" && s.prim !== "field" && s.prim !== "crackle") {
        strokeCircle(e.colorHi, sx, sy, R, e.alpha * 0.55, 1.2);
      }
    }
    drawn += 1;
  }
  ctx.globalAlpha = 1;
  ctx.setLineDash(NO_DASH);
  ctx.restore();
  return drawn;
}

/* ── primitives ────────────────────────────────────────────────────
 *
 * Every primitive receives ``R`` — the effect's radius in WORLD units
 * after the gain and the on-screen floor — and multiplies by ``dc.k``
 * to reach pixels. No primitive may read a pixel size directly; the
 * only screen-space quantities here are stroke widths, which are
 * divided by ``dc.z`` so they stay constant under zoom.
 */

/** Effect radius in world units: the table value, gained, floored so it
 * stays visible on a small stage. */
function radiusOf(spec: SpellEffectSpec): number {
  const r = spec.r * EFFECT_WORLD_GAIN;
  return r < dc.minR ? dc.minR : r;
}

function drawPrim(e: ActiveSpellEffect, sx: number, sy: number, R: number): void {
  switch (e.spec.prim) {
    case "crackle": return drawCrackle(e, sx, sy, R);
    case "ring": return drawRing(e, sx, sy, R);
    case "field": return drawField(e, sx, sy, R);
    case "splat": return drawSplat(e, sx, sy, R);
    case "pulse": return drawPulse(e, sx, sy, R);
    case "aura": return drawAura(e, sx, sy, R);
    case "beam": return drawBeam(e, sx, sy, R);
    case "sweep": return drawSweep(e, sx, sy, R);
  }
}

/** Blit a cached stamp as a disc of world radius ``rWorld``. */
function blit(color: string, kind: StampKind, cx: number, cy: number, rWorld: number, alpha: number): void {
  if (alpha <= 0.002) return;
  const img = stamp(color, kind);
  if (!img) return;
  const r = rWorld * dc.k;
  // Canvas IGNORES an out-of-range globalAlpha rather than clamping it,
  // which would silently leave the previous effect's alpha in force.
  dc.g.globalAlpha = alpha > 1 ? 1 : alpha;
  dc.g.drawImage(img, cx - r, cy - r, r * 2, r * 2);
}

/** Stroke a circle of world radius ``rWorld``, ``px`` screen px wide. */
function strokeCircle(color: string, cx: number, cy: number, rWorld: number, alpha: number, px: number): void {
  if (alpha <= 0.002) return;
  const g = dc.g;
  g.globalAlpha = alpha > 1 ? 1 : alpha;
  g.strokeStyle = color;
  g.lineWidth = px / dc.z;
  g.beginPath();
  g.arc(cx, cy, rWorld * dc.k, 0, Math.PI * 2);
  g.stroke();
}

/**
 * Psi Storm: a bruised purple disc with lightning writhing inside it.
 * The arcs re-roll ``CRACKLE_HZ`` times per GAME second — quantising to
 * a tick is what keeps the storm deterministic under scrubbing while
 * still crackling at 16× playback.
 */
function drawCrackle(e: ActiveSpellEffect, sx: number, sy: number, R: number): void {
  const g = dc.g;
  // Body: a dark bloom that breathes very slightly.
  const breathe = 1 + 0.04 * Math.sin(dc.now * 6.2 + e.src);
  blit(e.color, "core", sx, sy, R * breathe, e.alpha * 0.5);
  blit(e.colorHi, "glow", sx, sy, R * 0.42, e.alpha * 0.35);

  const tick = Math.floor(dc.now * CRACKLE_HZ);
  const rPx = R * dc.k;
  g.globalAlpha = e.alpha * 0.9;
  g.strokeStyle = e.colorHi;
  g.lineWidth = 1.4 / dc.z;
  g.beginPath();
  for (let a = 0; a < 6; a += 1) {
    const seed = (e.src * 977 + tick * 131 + a * 7919) | 0;
    const ang = phaseOffset(seed) * Math.PI * 2;
    const len = 0.45 + phaseOffset(seed ^ 0x5bf03635) * 0.55;
    g.moveTo(sx, sy);
    for (let step = 1; step <= 3; step += 1) {
      const f = (step / 3) * len;
      const jitter = (phaseOffset(seed + step * 2654435761) - 0.5) * 0.9;
      const th = ang + jitter;
      g.lineTo(sx + Math.cos(th) * rPx * f, sy + Math.sin(th) * rPx * f);
    }
  }
  g.stroke();
  // Rim, so the area of effect is legible even when the arcs are dim.
  strokeCircle(e.color, sx, sy, R, e.alpha * 0.35, 1.2);
}

/** EMP / Nova / Nuke / Widow Mine: a shock front leaving the impact. */
function drawRing(e: ActiveSpellEffect, sx: number, sy: number, R: number): void {
  const p = e.p < 0 ? 0 : e.p;
  // Ease-out: fast front, slow tail — an explosion, not a balloon.
  const grow = 1 - (1 - p) * (1 - p);
  const r = R * (0.12 + 0.88 * grow);
  blit(e.colorHi, "glow", sx, sy, R * 0.5 * (1 - p * 0.6), e.alpha * 0.55 * (1 - p));
  blit(e.color, "edge", sx, sy, r, e.alpha * 0.5);
  strokeCircle(e.colorHi, sx, sy, r, e.alpha * (1 - p * 0.75), 2);
}

/** Fungal / Time Warp / Force Field / shields: a body of tinted air
 * with an edge that slowly turns, so a 10-second field never looks
 * like a frozen sticker. */
function drawField(e: ActiveSpellEffect, sx: number, sy: number, R: number): void {
  const g = dc.g;
  blit(e.color, "core", sx, sy, R, e.alpha * 0.55);
  blit(e.colorHi, "glow", sx, sy, R * 0.55, e.alpha * 0.2);
  // Moving edge: a dashed rim rotating at 1/6 rev per game second.
  const rot = dc.now * (Math.PI / 3) + e.src;
  g.globalAlpha = e.alpha * 0.85;
  g.strokeStyle = e.colorHi;
  g.lineWidth = 1.6 / dc.z;
  g.setLineDash(FIELD_DASH);
  g.lineDashOffset = -(rot * R * dc.k) / 2;
  g.beginPath();
  g.arc(sx, sy, R * dc.k, 0, Math.PI * 2);
  g.stroke();
  g.setLineDash(NO_DASH);
}

/** Corrosive Bile / Caustic Spray impact: a splat that spreads on
 * landing and dries out. */
function drawSplat(e: ActiveSpellEffect, sx: number, sy: number, R: number): void {
  const p = e.p < 0 ? 0 : e.p;
  const spread = Math.min(1, p * 4);
  blit(e.color, "core", sx, sy, R * (0.4 + 0.6 * spread), e.alpha * 0.8);
  // The landing flash: bright for the first quarter second only.
  if (p < 0.35) {
    const f = 1 - p / 0.35;
    blit(e.colorHi, "glow", sx, sy, R * (0.6 + 1.4 * (1 - f)), e.alpha * f * 0.7);
    strokeCircle(e.colorHi, sx, sy, R * (0.5 + 1.6 * (1 - f)), e.alpha * f * 0.8, 1.8);
  }
}

/** Stim / Blink / Burrow / Charge: two rings leaving the unit, half a
 * beat apart, over a small glow. Reads at a Marine's size. */
function drawPulse(e: ActiveSpellEffect, sx: number, sy: number, R: number): void {
  const p = e.p < 0 ? 0 : e.p;
  blit(e.colorHi, "glow", sx, sy, R * 0.5, e.alpha * 0.55 * (1 - p));
  for (let i = 0; i < 2; i += 1) {
    const q = p - i * 0.28;
    if (q <= 0 || q >= 1) continue;
    strokeCircle(e.color, sx, sy, R * (0.25 + 0.75 * q), e.alpha * (1 - q) * 0.9, 1.8);
  }
}

/** Chrono Boost / MULE / Contaminate: arcs orbiting a structure. The
 * rotation is the whole signal — a static ring would vanish into the
 * building's own outline. */
function drawAura(e: ActiveSpellEffect, sx: number, sy: number, R: number): void {
  const g = dc.g;
  blit(e.color, "glow", sx, sy, R, e.alpha * 0.4);
  const rot = dc.now * 2.1 + phaseOffset(e.src) * 6.28;
  const r = R * 0.82 * dc.k;
  g.globalAlpha = e.alpha;
  g.strokeStyle = e.colorHi;
  g.lineWidth = 2 / dc.z;
  g.beginPath();
  for (let i = 0; i < 3; i += 1) {
    const a0 = rot + (i * Math.PI * 2) / 3;
    // moveTo BEFORE each arc, or canvas chords the three together.
    g.moveTo(sx + Math.cos(a0) * r, sy + Math.sin(a0) * r);
    g.arc(sx, sy, r, a0, a0 + 0.85);
  }
  g.stroke();
}

/** Yamato / Abduct / Graviton / Neural: a link from the caster to the
 * target, with the target end doing the shouting. */
function drawBeam(e: ActiveSpellEffect, sx: number, sy: number, R: number): void {
  const g = dc.g;
  const p = e.p < 0 ? 0 : e.p;
  // A beam whose caster resolved to (essentially) the target itself —
  // a self-cast with no coordinates — has no line to draw; the target
  // glow alone reads correctly.
  if (Number.isFinite(e.cx) && Math.hypot(e.cx - e.wx, e.cy - e.wy) > 0.25) {
    const ox = projectX(dc.bounds, dc.proj, e.cx);
    const oy = projectY(dc.bounds, dc.proj, e.cy);
    // Two strokes instead of a gradient: a wide soft body and a thin
    // hot core. A per-frame createLinearGradient here would cost more
    // than the rest of the layer put together.
    g.globalAlpha = e.alpha * 0.35;
    g.strokeStyle = e.color;
    g.lineWidth = 5 / dc.z;
    g.beginPath();
    g.moveTo(ox, oy);
    g.lineTo(sx, sy);
    g.stroke();
    g.globalAlpha = e.alpha;
    g.strokeStyle = e.colorHi;
    g.lineWidth = 1.6 / dc.z;
    g.beginPath();
    g.moveTo(ox, oy);
    g.lineTo(sx, sy);
    g.stroke();
  }
  blit(e.colorHi, "glow", sx, sy, R * (0.7 + 0.3 * Math.sin(dc.now * 7 + e.src)), e.alpha * 0.8);
  strokeCircle(e.color, sx, sy, R * (0.6 + 0.5 * p), e.alpha * 0.6, 1.4);
}

/** Scanner Sweep / Revelation: a wide soft reveal with a radar wedge
 * turning inside it. Big radius, low alpha — it must not read as
 * damage. */
function drawSweep(e: ActiveSpellEffect, sx: number, sy: number, R: number): void {
  const g = dc.g;
  const r = R * dc.k;
  blit(e.color, "glow", sx, sy, R, e.alpha * 0.5);
  const rot = dc.now * 1.6 + phaseOffset(e.src) * 6.28;
  g.globalAlpha = e.alpha * 0.45;
  g.fillStyle = e.colorHi;
  g.beginPath();
  g.moveTo(sx, sy);
  g.arc(sx, sy, r, rot, rot + 0.42);
  g.closePath();
  g.fill();
  strokeCircle(e.color, sx, sy, R, e.alpha * 0.5, 1.2);
}

/* ── telegraph (the lead-in) ─────────────────────────────────────── */

/**
 * What is drawn between the order and the impact. Always on the
 * overlay layer — it is in the air.
 *
 *   "arc"     a projectile lobbed in from the caster (or from a fixed
 *             bearing when the caster is unknown): Corrosive Bile,
 *             Purification Nova, a MULE dropping out of orbit.
 *   "charge"  a beam brightening from the caster: Yamato, Snipe.
 *   "reticle" a shrinking dashed ring on the target: Nuke's dot.
 */
function drawTelegraph(e: ActiveSpellEffect, sx: number, sy: number, R: number): void {
  const s = e.spec;
  const g = dc.g;
  const q = e.tel < 0 ? 1 : e.tel;
  const style = s.tg ?? "reticle";

  if (style === "charge" && Number.isFinite(e.cx) && Math.hypot(e.cx - e.wx, e.cy - e.wy) > 0.25) {
    const ox = projectX(dc.bounds, dc.proj, e.cx);
    const oy = projectY(dc.bounds, dc.proj, e.cy);
    g.globalAlpha = e.alpha * (0.3 + 0.7 * q);
    g.strokeStyle = e.colorHi;
    g.lineWidth = (0.8 + 2.6 * q) / dc.z;
    g.beginPath();
    g.moveTo(ox, oy);
    g.lineTo(sx, sy);
    g.stroke();
    blit(e.colorHi, "glow", ox, oy, R * (0.4 + 0.8 * q), e.alpha * q);
    strokeCircle(e.color, sx, sy, R * (1.8 - 0.8 * q), e.alpha * 0.7, 1.4);
    return;
  }

  if (style === "arc" && Number.isFinite(e.cx) && Number.isFinite(e.cy)) {
    const ox = projectX(dc.bounds, dc.proj, e.cx);
    const oy = projectY(dc.bounds, dc.proj, e.cy);
    // Parabolic lob: linear in the ground plane, a sine hop in screen Y.
    const px = ox + (sx - ox) * q;
    const lift = Math.max(R * 3, 5) * dc.k * Math.sin(Math.PI * q);
    const py = oy + (sy - oy) * q - lift;
    g.globalAlpha = e.alpha * 0.55;
    g.strokeStyle = e.color;
    g.lineWidth = 1.2 / dc.z;
    g.beginPath();
    g.moveTo(ox, oy);
    for (let i = 1; i <= 10; i += 1) {
      const f = (i / 10) * q;
      g.lineTo(
        ox + (sx - ox) * f,
        oy + (sy - oy) * f - Math.max(R * 3, 5) * dc.k * Math.sin(Math.PI * f),
      );
    }
    g.stroke();
    blit(e.colorHi, "glow", px, py, R * 0.6, e.alpha * 1.4);
    // Landing mark, tightening as it closes.
    strokeCircle(e.color, sx, sy, R * (1.6 - 0.6 * q), e.alpha * 0.8, 1.4);
    return;
  }

  // reticle — a dashed ring closing on the target with a blinking dot.
  const r = R * (2.2 - 1.2 * q);
  g.globalAlpha = e.alpha;
  g.strokeStyle = e.colorHi;
  g.lineWidth = 1.6 / dc.z;
  g.setLineDash(FIELD_DASH);
  g.lineDashOffset = -dc.now * 12;
  g.beginPath();
  g.arc(sx, sy, r * dc.k, 0, Math.PI * 2);
  g.stroke();
  g.setLineDash(NO_DASH);
  // Blink rate accelerates as the impact approaches.
  const blinkHz = 1.5 + 6 * q;
  const on = Math.sin(dc.now * blinkHz * Math.PI * 2) > -0.2 ? 1 : 0.25;
  blit(e.colorHi, "glow", sx, sy, R * 0.45, e.alpha * on * 1.3);
}

function clamp01(v: number): number {
  return v < 0 ? 0 : v > 1 ? 1 : v;
}
