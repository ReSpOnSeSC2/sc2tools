/**
 * replayMusic — the map replay's background score.
 *
 * A replay is silent film: units slide around a map with no sound at
 * all. This layer scores it. It is deliberately NOT "loop an mp3":
 *
 *   selection   the track follows the REVIEWING player's race, and
 *               which take you get is a pure function of the game's
 *               id — the same replay sounds the same every time it is
 *               opened, on every device. Never ``Math.random()``.
 *   gesture     browsers refuse to start audio without a user gesture.
 *               The transport's Play button IS that gesture, so the
 *               ``AudioContext`` is created inside that click handler
 *               and nowhere else (see ``setPlaying``). Toggling music
 *               ON while the replay is already running is itself a
 *               gesture and starts audio the same way.
 *   scoring     the gain is modulated by how close the playhead is to
 *               a battle marker (a raised-cosine window, §"tuning"),
 *               plus a slow term from combined army value so the late
 *               game sits a little louder than the opening. Subtle:
 *               +30 % at the peak of a fight, not a klaxon.
 *   scrub-safe  that gain is a PURE function of
 *               ``(time, battles, stats, settings)`` — no envelope
 *               follower, no accumulator, nothing that drifts. Scrub
 *               backwards through a fight and it swells again.
 *   speed       playback speed does NOT touch ``playbackRate``. Music
 *               at 16× would be a chipmunk. The battle window widens
 *               with speed instead, so the swell lasts a musically
 *               sensible ~1.5–6 wall-clock seconds at every speed.
 *   variety     tracks are 2.5–3.3 min and games run 5–30, so the
 *               loop rotates deterministically through the tracks
 *               that fit the situation and crossfades the seam.
 *
 * AUDIO GRAPH (Web Audio path)
 *
 *     <audio> A ──▶ deckGain A ─┐
 *                               ├─▶ levelGain ──▶ envelopeGain ──▶ out
 *     <audio> B ──▶ deckGain B ─┘
 *
 * Exactly one writer per node, which is why nothing ever fights over a
 * scheduled ramp: ``deckGain`` is the loop crossfade, ``levelGain`` is
 * the score (volume × battle swell), ``envelopeGain`` is the play/pause
 * fade. Two elements, two source nodes, one context — for the whole
 * mounted lifetime, whatever the rotation does.
 *
 * ``HTMLAudioElement`` + ``createMediaElementSource``, NOT
 * ``decodeAudioData``: a 3 MB mp3 decodes to ~35 MB of PCM and would
 * have to arrive in full before the first note. Streaming starts in a
 * few hundred ms and costs no heap. The price is that
 * ``createMediaElementSource`` requires the media be same-origin or
 * CORS-clean — hence ``crossOrigin = "anonymous"`` on the element, and
 * hence the R2 bucket/Worker MUST send permissive
 * ``Access-Control-Allow-Origin``. If it does not, the source node
 * throws and this module falls back to driving ``element.volume``
 * directly: the play/pause fades and the track rotation still work,
 * the battle swell and the crossfaded loop seam do not.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { MapPlayback } from "@/lib/mapReplay";

/* ============================================================
 * Track manifest
 * ============================================================ */

/**
 * Where the score is served from. Relative by default so a dev build
 * can drop the files in ``public/audio/replay``; production points
 * this at the R2 bucket / Worker. Never hard-code an absolute URL
 * anywhere else.
 */
export const AUDIO_BASE = (
  process.env.NEXT_PUBLIC_AUDIO_BASE || "/audio/replay"
).replace(/\/+$/, "");

export type MusicRace = "Terran" | "Zerg" | "Protoss";

export interface MusicTrack {
  id: string;
  /**
   * Object key under ``AUDIO_BASE``. Explicit rather than derived
   * from ``id`` so a key can be corrected here without renaming a
   * file or touching the selection logic. The layout is flat and
   * mirrors ``apps/web/public/audio/replay/`` exactly, which is what
   * ``scripts/upload-sprites.mjs --source apps/web/public/audio/replay``
   * copies into R2.
   */
  path: string;
  race: MusicRace;
  /** Seconds, from the encoder. Used for loop scheduling before the
   *  element reports its own ``duration``. */
  duration: number;
  /** ``bed`` loops; ``cue`` is a short sting played once at the top. */
  role: "bed" | "cue";
  title: string;
  /** One-line mood, surfaced in the control's tooltip. */
  mood: string;
}

export const TRACKS: readonly MusicTrack[] = [
  {
    id: "terran-iron-front-protocol",
    path: "terran-iron-front-protocol.mp3",
    race: "Terran",
    duration: 187.8,
    role: "bed",
    title: "Iron Front Protocol",
    mood: "industrial rock",
  },
  {
    id: "protoss-orbital-reliquary",
    path: "protoss-orbital-reliquary.mp3",
    race: "Protoss",
    duration: 199.1,
    role: "bed",
    title: "Orbital Reliquary",
    mood: "ethereal ambient",
  },
  {
    id: "protoss-orbital-reliquary-ii",
    path: "protoss-orbital-reliquary-ii.mp3",
    race: "Protoss",
    duration: 199.5,
    role: "bed",
    title: "Orbital Reliquary II",
    mood: "ethereal ambient",
  },
  {
    id: "zerg-chitin-rift",
    path: "zerg-chitin-rift.mp3",
    race: "Zerg",
    duration: 154.0,
    role: "bed",
    title: "Chitin Rift",
    mood: "dark organic",
  },
  {
    id: "zerg-chitin-rift-sting",
    path: "zerg-chitin-rift-sting.mp3",
    race: "Zerg",
    duration: 34.0,
    role: "cue",
    title: "Chitin Rift (sting)",
    mood: "dark organic",
  },
];

export function trackUrl(track: MusicTrack): string {
  return `${AUDIO_BASE}/${track.path}`;
}

/* ============================================================
 * Tuning — every dial the score has, in one block
 * ============================================================ */

export const MUSIC_TUNING = {
  /** Default level. Modest: this is a bed under analysis, not a set. */
  DEFAULT_VOLUME: 0.35,
  /** Play → full level, and pause → silence. Asymmetric on purpose: a
   *  slow bloom in, a quick duck out. */
  FADE_IN_SEC: 2,
  FADE_OUT_SEC: 1,
  /** Loop seam. Long enough to hide the join on an ambient bed. */
  CROSSFADE_SEC: 1.5,
  /** How early the next deck is given its ``src`` so it has buffered
   *  by the time the crossfade starts. */
  PRELOAD_LEAD_SEC: 12,
  /** Half-width of the battle window at 1×, in REPLAY seconds: a fight
   *  is audible from 6 s out, peaks on the marker, and is gone 6 s
   *  later. */
  BATTLE_WINDOW_SEC: 6,
  /** …widened by ``speed ** this`` so the swell still lasts ~1.5–6
   *  WALL seconds at 4× / 8× / 16×. At 0.5 the window is 6 s of wall
   *  time at 1× and 1.5 s at 16×. Without it a battle at 16× would be
   *  a 0.4 s blip nobody could hear as scoring. */
  BATTLE_WINDOW_SPEED_EXP: 0.5,
  /** Peak swell over the base level at the centre of a fight. */
  BATTLE_SWELL: 0.3,
  /** Slow term: how much louder a maxed-out army is than an empty map. */
  ARMY_SWELL: 0.12,
  /** Combined (both sides) army value below which the slow term is
   *  treated as "no army yet" rather than scaled against this game's
   *  own peak — stops a 4-minute cheese from swelling to full on 300
   *  minerals of Zerglings. */
  ARMY_FLOOR: 1500,
  /** Hard ceiling on element gain so a loud user setting plus a full
   *  swell cannot clip the (−16 LUFS) masters. */
  MAX_GAIN: 1,
  /** Score update rate. 10 Hz against a 4 Hz clock publish — the ramp
   *  below does the smoothing, so this is not a busy loop. */
  TICK_MS: 100,
  /** Every level change is a ramp of this long, never a step. */
  LEVEL_RAMP_SEC: 0.18,
} as const;

/* ============================================================
 * Pure maths — everything below is a function of its arguments
 * ============================================================ */

function clamp01(v: number): number {
  if (!Number.isFinite(v)) return 0;
  return v < 0 ? 0 : v > 1 ? 1 : v;
}

/** Smoothstep, for easing the slow army term in and out of its range. */
function smoothstep01(v: number): number {
  const x = clamp01(v);
  return x * x * (3 - 2 * x);
}

/** FNV-1a. Small, stable across engines, and — unlike anything seeded
 *  from ``Date`` or ``Math.random`` — identical on every device. */
export function hashSeed(seed: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < seed.length; i++) {
    h ^= seed.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

/**
 * A stable identity for one replay. ``gameId`` when the host has one;
 * otherwise a fingerprint of the payload, which is stable for a given
 * game and differs between games on the same map.
 */
export function musicSeed(
  gameId: string | null | undefined,
  playback?: MapPlayback | null,
): string {
  const id = (gameId ?? "").trim();
  if (id) return id;
  if (!playback) return "replay";
  return [
    playback.mapName || "map",
    Math.round(playback.gameLength),
    playback.units.length,
    playback.buildings.length,
    playback.battles.length,
  ].join("|");
}

const RACES: readonly MusicRace[] = ["Terran", "Zerg", "Protoss"];

/** Accepts "Terran"/"terran"/"T"; anything else (Random, "", null) is
 *  unknown and gets a seeded pick. */
export function normalizeRace(race: string | null | undefined): MusicRace | null {
  const s = String(race ?? "").trim().toLowerCase();
  if (!s) return null;
  if (s === "t" || s.startsWith("terr")) return "Terran";
  if (s === "z" || s.startsWith("zerg")) return "Zerg";
  if (s === "p" || s.startsWith("prot")) return "Protoss";
  return null;
}

export interface MusicPlan {
  /** The race the score follows — the prop's, or a seeded pick. */
  race: MusicRace;
  /** True when the race was picked from the seed, not supplied. */
  guessed: boolean;
  /** Short cues, played once each before the loop rotation starts. */
  intro: readonly MusicTrack[];
  /** Loop bodies, already rotated into THIS game's order. */
  beds: readonly MusicTrack[];
}

/**
 * Which tracks this replay plays, and in what order. Pure: same race
 * plus same seed always yields the same plan.
 */
export function musicPlan(
  race: string | null | undefined,
  seed: string,
): MusicPlan {
  const known = normalizeRace(race);
  const h = hashSeed(seed);
  const chosen = known ?? RACES[h % RACES.length];
  const intro = TRACKS.filter((t) => t.race === chosen && t.role === "cue");
  const beds = TRACKS.filter((t) => t.race === chosen && t.role === "bed");
  // Rotate the bed list by a seeded offset. With one bed (Terran,
  // Zerg) this is the identity; with two (Protoss) it decides which
  // take opens the game — deterministically, so the same replay always
  // sounds the same. Adding a second Terran take to the manifest is
  // all it takes for Terran to vary the same way.
  const off = beds.length > 1 ? (h >>> 8) % beds.length : 0;
  const rotated = beds.map((_, i) => beds[(i + off) % beds.length]);
  return { race: chosen, guessed: known === null, intro, beds: rotated };
}

/** The track for the k-th slot of a plan: cues first, then the beds on
 *  repeat. Never throws — an empty manifest falls back to track 0. */
export function trackAt(plan: MusicPlan, slot: number): MusicTrack {
  const i = Math.max(0, Math.floor(Number.isFinite(slot) ? slot : 0));
  if (i < plan.intro.length) return plan.intro[i];
  const beds = plan.beds;
  if (beds.length === 0) return plan.intro[plan.intro.length - 1] ?? TRACKS[0];
  return beds[(i - plan.intro.length) % beds.length];
}

/** Convenience for callers (and tests) that have no plan in hand. */
export function trackForSlot(
  race: string | null | undefined,
  seed: string,
  slot: number,
): MusicTrack {
  return trackAt(musicPlan(race, seed), slot);
}

/**
 * How much "battle" is happening at ``time``.
 *
 * A raised cosine centred on each marker: 1 exactly on it, 0 at
 * ``windowSec`` either side, with zero slope at both ends so the swell
 * eases in and out instead of ramping linearly into a corner. Nearby
 * fights take the max rather than summing, so a brawl with six markers
 * in it is as loud as one — the ceiling is the point.
 *
 * Symmetric in ``time`` about each marker, and clamped to [0,1] by
 * construction.
 */
export function battleIntensity(
  time: number,
  battles: readonly { t: number }[] | null | undefined,
  windowSec: number,
): number {
  if (!battles || battles.length === 0) return 0;
  if (!Number.isFinite(time) || !(windowSec > 0)) return 0;
  let peak = 0;
  for (let i = 0; i < battles.length; i++) {
    const d = Math.abs(time - battles[i].t);
    if (!(d < windowSec)) continue;
    const v = 0.5 * (1 + Math.cos((Math.PI * d) / windowSec));
    if (v > peak) {
      peak = v;
      if (peak >= 1) break;
    }
  }
  return clamp01(peak);
}

/** ``[t, armyValue, workers, supplyUsed]`` rows, ascending ``t``. */
type StatRows = readonly (readonly number[])[];

/** Linear sample of one column of a stats series, clamped at both ends. */
function sampleStat(rows: StatRows | null | undefined, time: number, col: number): number {
  if (!rows || rows.length === 0) return 0;
  const first = rows[0];
  if (!first) return 0;
  if (time <= first[0]) return Number(first[col]) || 0;
  const last = rows[rows.length - 1];
  if (time >= last[0]) return Number(last[col]) || 0;
  let lo = 0;
  let hi = rows.length - 1;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (rows[mid][0] <= time) lo = mid;
    else hi = mid;
  }
  const a = rows[lo];
  const b = rows[hi];
  const span = b[0] - a[0];
  const av = Number(a[col]) || 0;
  const bv = Number(b[col]) || 0;
  if (!(span > 0)) return bv;
  return av + (bv - av) * ((time - a[0]) / span);
}

function peakCombinedArmy(stats: MapPlayback["stats"] | null | undefined): number {
  if (!stats) return 0;
  const rows = Math.max(stats.me?.length ?? 0, stats.opp?.length ?? 0);
  let peak = 0;
  for (let i = 0; i < rows; i++) {
    const a = Number(stats.me?.[i]?.[1]) || 0;
    const b = Number(stats.opp?.[i]?.[1]) || 0;
    // The two series are sampled on the same cadence by the pipeline;
    // even if they were not, this is a scale reference, not a readout.
    if (a + b > peak) peak = a + b;
  }
  return peak;
}

/**
 * The slow term: combined army value at ``time`` against this game's
 * own peak, eased. 0 through the opening, ~1 at the biggest army the
 * game ever fields, so a 25-minute macro game gets quietly heavier as
 * it goes without every game swelling to the same absolute number.
 */
export function armyPressure(
  time: number,
  stats: MapPlayback["stats"] | null | undefined,
  floor: number = MUSIC_TUNING.ARMY_FLOOR,
): number {
  if (!stats) return 0;
  const combined =
    sampleStat(stats.me, time, 1) + sampleStat(stats.opp, time, 1);
  const reference = Math.max(peakCombinedArmy(stats), floor);
  if (!(reference > 0)) return 0;
  return smoothstep01(combined / reference);
}

export interface ScoreSettings {
  /** User level, 0..1. */
  volume: number;
  /** Half-width of the battle window in replay seconds (already scaled
   *  for playback speed by ``battleWindowFor``). */
  battleWindowSec: number;
  battleSwell: number;
  armySwell: number;
}

export function defaultScoreSettings(volume: number): ScoreSettings {
  return {
    volume,
    battleWindowSec: MUSIC_TUNING.BATTLE_WINDOW_SEC,
    battleSwell: MUSIC_TUNING.BATTLE_SWELL,
    armySwell: MUSIC_TUNING.ARMY_SWELL,
  };
}

/** Battle window half-width at a given playback speed. See the tuning
 *  block for why this is not simply a constant. */
export function battleWindowFor(speed: number): number {
  const s = Number.isFinite(speed) && speed > 0 ? speed : 1;
  return (
    MUSIC_TUNING.BATTLE_WINDOW_SEC *
    Math.pow(s, MUSIC_TUNING.BATTLE_WINDOW_SPEED_EXP)
  );
}

/**
 * THE gain, and the only thing the audio graph's level node is ever
 * set to. A pure function of the playhead and the payload: scrub
 * anywhere, forwards or backwards, and the answer for a given time is
 * always the same. Fades (play/pause) and the loop crossfade are
 * separate multipliers on separate nodes — they are envelopes over
 * wall time, and mixing them in here is exactly the accumulating state
 * this function refuses to have.
 */
export function musicGain(
  time: number,
  battles: readonly { t: number }[] | null | undefined,
  stats: MapPlayback["stats"] | null | undefined,
  settings: ScoreSettings,
): number {
  const base = clamp01(settings.volume);
  if (base <= 0) return 0;
  const swell =
    1 +
    settings.battleSwell * battleIntensity(time, battles, settings.battleWindowSec) +
    settings.armySwell * armyPressure(time, stats);
  return Math.min(MUSIC_TUNING.MAX_GAIN, base * swell);
}

/* ============================================================
 * Preferences
 * ============================================================ */

export const MUSIC_STORAGE_KEY = "sc2tools.replay.music.v1";

export interface MusicPrefs {
  enabled: boolean;
  volume: number;
}

/** ``prefers-reduced-motion: reduce`` is the closest thing the platform
 *  has to "I want less sensory load", so it defaults the score OFF.
 *  Still a default: one click turns it on and that choice persists. */
export function prefersReducedMotion(): boolean {
  if (typeof window === "undefined" || typeof window.matchMedia !== "function") {
    return false;
  }
  try {
    return window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  } catch {
    return false;
  }
}

export function defaultMusicPrefs(): MusicPrefs {
  return {
    enabled: !prefersReducedMotion(),
    volume: MUSIC_TUNING.DEFAULT_VOLUME,
  };
}

export function loadMusicPrefs(): MusicPrefs {
  const fallback = defaultMusicPrefs();
  if (typeof window === "undefined") return fallback;
  try {
    const raw = window.localStorage.getItem(MUSIC_STORAGE_KEY);
    if (!raw) return fallback;
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object") return fallback;
    const rec = parsed as Partial<MusicPrefs>;
    return {
      enabled: typeof rec.enabled === "boolean" ? rec.enabled : fallback.enabled,
      volume:
        typeof rec.volume === "number" && Number.isFinite(rec.volume)
          ? clamp01(rec.volume)
          : fallback.volume,
    };
  } catch {
    // Corrupt JSON, or storage blocked entirely (Safari private mode
    // throws on read). Neither is worth a console line.
    return fallback;
  }
}

export function saveMusicPrefs(prefs: MusicPrefs): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(
      MUSIC_STORAGE_KEY,
      JSON.stringify({ enabled: !!prefs.enabled, volume: clamp01(prefs.volume) }),
    );
  } catch {
    // Quota or blocked storage: the preference just does not persist.
  }
}

/* ============================================================
 * The engine
 * ============================================================ */

type AudioContextCtor = new () => AudioContext;

function audioContextCtor(): AudioContextCtor | null {
  if (typeof window === "undefined") return null;
  const w = window as unknown as {
    AudioContext?: AudioContextCtor;
    webkitAudioContext?: AudioContextCtor;
  };
  return w.AudioContext ?? w.webkitAudioContext ?? null;
}

function createAudioElement(): HTMLAudioElement | null {
  if (typeof window === "undefined") return null;
  try {
    const el =
      typeof window.Audio === "function"
        ? new window.Audio()
        : (document.createElement("audio") as HTMLAudioElement);
    el.preload = "auto";
    // We rotate tracks ourselves; the element must NOT loop.
    el.loop = false;
    // REQUIRED for the Web Audio path: createMediaElementSource refuses
    // a cross-origin element unless the response is CORS-clean.
    el.crossOrigin = "anonymous";
    return el;
  } catch {
    return null;
  }
}

interface Deck {
  el: HTMLAudioElement;
  gain: GainNode | null;
  track: MusicTrack | null;
  slot: number;
  /** Element-level level in the no-Web-Audio fallback, 0..1. */
  fade: number;
}

export interface ReplayMusicEngineOptions {
  /** Called once if the score gives up (asset 404, decode failure).
   *  The control renders itself unavailable; the replay is untouched. */
  onUnavailable?: () => void;
  /** Called when the audible track changes, for the tooltip. */
  onTrackChange?: (track: MusicTrack | null) => void;
}

/**
 * Owns the audio graph. Everything that is not a pure function lives
 * here, and every entry point is safe to call at any time, in any
 * order, including after ``dispose``.
 */
export class ReplayMusicEngine {
  private readonly opts: ReplayMusicEngineOptions;

  private ctx: AudioContext | null = null;
  private levelGain: GainNode | null = null;
  private envelopeGain: GainNode | null = null;
  private decks: Deck[] = [];
  private active = 0;
  private webAudio = false;

  private plan: MusicPlan | null = null;
  private battles: readonly { t: number }[] = [];
  private stats: MapPlayback["stats"] | null = null;

  private enabled = true;
  private volume: number = MUSIC_TUNING.DEFAULT_VOLUME;
  private playing = false;
  private time = 0;
  private speed = 1;

  private started = false;
  private crossfading = false;
  private tick: ReturnType<typeof setInterval> | null = null;
  private stopTimer: ReturnType<typeof setTimeout> | null = null;
  private disposed = false;
  private failed = false;

  constructor(opts: ReplayMusicEngineOptions = {}) {
    this.opts = opts;
  }

  /* ---- inputs ---------------------------------------------------- */

  setPlan(plan: MusicPlan | null): void {
    const prev = this.plan;
    this.plan = plan;
    if (!plan || this.disposed) return;
    const same =
      prev &&
      prev.race === plan.race &&
      prev.intro.length === plan.intro.length &&
      prev.beds.length === plan.beds.length &&
      prev.intro.every((t, i) => t.id === plan.intro[i]?.id) &&
      prev.beds.every((t, i) => t.id === plan.beds[i]?.id);
    if (same) return;
    if (!this.started) {
      // Nothing is audible yet: forget what the decks were holding so
      // the next play press opens on the new plan's first track.
      for (const deck of this.decks) {
        deck.track = null;
        deck.slot = -1;
      }
      return;
    }
    // The game changed under a running score (a host swapping payloads
    // without remounting). Slide into the new plan rather than cutting.
    this.beginCrossfade(0);
  }

  setPlayback(playback: MapPlayback | null): void {
    this.battles = playback?.battles ?? [];
    this.stats = playback?.stats ?? null;
  }

  setTime(time: number): void {
    if (Number.isFinite(time)) this.time = time;
  }

  setSpeed(speed: number): void {
    // Deliberately NOT wired to element.playbackRate: the score plays
    // at 1× at every replay speed. Speed only widens the battle window.
    if (Number.isFinite(speed) && speed > 0) this.speed = speed;
  }

  setVolume(volume: number): void {
    this.volume = clamp01(volume);
    this.applyLevel();
  }

  /** Toggling music ON from the control counts as a user gesture, so if
   *  the replay is already running this starts audio right here. */
  setEnabled(enabled: boolean): void {
    if (this.enabled === enabled) return;
    this.enabled = enabled;
    if (this.disposed) return;
    if (enabled) {
      if (this.playing) this.start();
    } else {
      this.stop();
    }
  }

  /**
   * THE gesture entry point. Called synchronously from the transport's
   * play/pause click handler, which is what makes creating (or
   * resuming) the AudioContext here legal.
   */
  setPlaying(playing: boolean): void {
    if (this.playing === playing) return;
    this.playing = playing;
    if (this.disposed) return;
    if (playing) {
      if (this.enabled) this.start();
    } else {
      this.stop();
    }
  }

  get available(): boolean {
    return !this.failed;
  }

  get currentTrack(): MusicTrack | null {
    return this.decks[this.active]?.track ?? null;
  }

  /* ---- lifecycle ------------------------------------------------- */

  private start(): void {
    if (this.disposed || this.failed || !this.plan) return;
    if (this.stopTimer !== null) {
      clearTimeout(this.stopTimer);
      this.stopTimer = null;
    }
    if (!this.ensureGraph()) return;

    // A context created before any gesture starts suspended, and one
    // that has been idle can be suspended by the browser at any time.
    // Resuming is a no-op when it is already running.
    const ctx = this.ctx;
    if (ctx && ctx.state !== "running") {
      const p = ctx.resume?.();
      if (p && typeof p.catch === "function") p.catch(() => this.giveUp());
    }

    const deck = this.decks[this.active];
    if (!deck) return;
    if (!deck.track) this.loadDeck(deck, 0);
    this.playDeck(deck);
    this.setDeckFade(deck, 1, 0);
    this.applyLevel();
    this.fadeEnvelope(1, MUSIC_TUNING.FADE_IN_SEC);
    this.startTicking();
    this.started = true;
  }

  private stop(): void {
    if (!this.started) return;
    this.fadeEnvelope(0, MUSIC_TUNING.FADE_OUT_SEC);
    // The element keeps playing THROUGH the ramp — pausing now would
    // cut the fade off at its first sample.
    if (this.stopTimer !== null) clearTimeout(this.stopTimer);
    this.stopTimer = setTimeout(
      () => {
        this.stopTimer = null;
        if (this.disposed || this.playing) return;
        for (const deck of this.decks) this.pauseDeck(deck);
        this.stopTicking();
        this.started = false;
        // Free the audio thread while the replay is paused. The next
        // play press resumes it (the document is already activated).
        if (this.ctx && this.ctx.state === "running") {
          const p = this.ctx.suspend?.();
          if (p && typeof p.catch === "function") p.catch(() => {});
        }
      },
      Math.round(MUSIC_TUNING.FADE_OUT_SEC * 1000) + 80,
    );
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.started = false;
    this.crossfading = false;
    this.stopTicking();
    if (this.stopTimer !== null) {
      clearTimeout(this.stopTimer);
      this.stopTimer = null;
    }
    for (const deck of this.decks) {
      try {
        deck.el.pause();
      } catch {
        /* already gone */
      }
      deck.el.onerror = null;
      // Drop the stream so the network request and decoder go away with
      // the element instead of outliving the page transition.
      try {
        deck.el.removeAttribute("src");
        deck.el.load();
      } catch {
        /* jsdom and friends */
      }
      try {
        deck.gain?.disconnect();
      } catch {
        /* not connected */
      }
    }
    this.decks = [];
    try {
      this.levelGain?.disconnect();
      this.envelopeGain?.disconnect();
    } catch {
      /* not connected */
    }
    this.levelGain = null;
    this.envelopeGain = null;
    // Browsers cap concurrent AudioContexts (Chrome at ~6) — navigating
    // between six games without this would silence the seventh.
    const ctx = this.ctx;
    this.ctx = null;
    if (ctx) {
      try {
        const p = ctx.close?.();
        if (p && typeof p.catch === "function") p.catch(() => {});
      } catch {
        /* already closed */
      }
    }
  }

  /** Silently stand down: a 404, a decode failure, a context the
   *  browser refuses to start. The replay must not notice. */
  private giveUp(): void {
    if (this.failed) return;
    this.failed = true;
    const notify = this.opts.onUnavailable;
    this.dispose();
    this.disposed = false; // still accepts calls; they all no-op now
    notify?.();
  }

  /* ---- graph ----------------------------------------------------- */

  private ensureGraph(): boolean {
    if (this.failed || this.disposed) return false;
    if (this.decks.length > 0) return true;

    const a = createAudioElement();
    const b = createAudioElement();
    if (!a || !b) {
      this.giveUp();
      return false;
    }
    this.decks = [
      { el: a, gain: null, track: null, slot: -1, fade: 0 },
      { el: b, gain: null, track: null, slot: -1, fade: 0 },
    ];
    for (const deck of this.decks) {
      deck.el.onerror = () => this.giveUp();
    }

    const Ctor = audioContextCtor();
    if (Ctor) {
      try {
        const ctx = new Ctor();
        // Adopted BEFORE anything below can throw: a context that is
        // only referenced by a local would be leaked by the catch, and
        // browsers cap how many a page may hold.
        this.ctx = ctx;
        const envelope = ctx.createGain();
        const level = ctx.createGain();
        envelope.gain.value = 0;
        level.gain.value = 0;
        level.connect(envelope);
        envelope.connect(ctx.destination);
        for (const deck of this.decks) {
          // Throws if the element is cross-origin without CORS headers.
          const src = ctx.createMediaElementSource(deck.el);
          const gain = ctx.createGain();
          gain.gain.value = 0;
          src.connect(gain);
          gain.connect(level);
          deck.gain = gain;
          deck.el.volume = 1; // the graph owns the level from here
        }
        this.levelGain = level;
        this.envelopeGain = envelope;
        this.webAudio = true;
      } catch {
        // No Web Audio for us — most likely the CDN did not send
        // Access-Control-Allow-Origin. Fall back to the element's own
        // volume: the play/pause fades and the track rotation survive
        // (stepped through the ticker), the battle swell and the
        // crossfaded loop seam do not.
        this.teardownContext();
        this.webAudio = false;
      }
    }
    if (!this.webAudio) {
      for (const deck of this.decks) deck.el.volume = 0;
    }
    return true;
  }

  private teardownContext(): void {
    const ctx = this.ctx;
    this.ctx = null;
    this.levelGain = null;
    this.envelopeGain = null;
    for (const deck of this.decks) deck.gain = null;
    if (!ctx) return;
    try {
      const p = ctx.close?.();
      if (p && typeof p.catch === "function") p.catch(() => {});
    } catch {
      /* already closed */
    }
  }

  private now(): number {
    return this.ctx ? this.ctx.currentTime : 0;
  }

  /** One ramp helper so nothing in this file ever assigns ``.value``
   *  during playback — a step there is an audible click. */
  private ramp(param: AudioParam | null, to: number, seconds: number): void {
    if (!param) return;
    const t0 = this.now();
    const target = Math.max(0, Math.min(1.5, to));
    try {
      param.cancelScheduledValues(t0);
      param.setValueAtTime(param.value, t0);
      param.linearRampToValueAtTime(target, t0 + Math.max(0.01, seconds));
    } catch {
      param.value = target;
    }
  }

  /* ---- envelope / level / decks ---------------------------------- */

  private fadeEnvelope(to: number, seconds: number): void {
    if (this.webAudio) {
      this.ramp(this.envelopeGain?.gain ?? null, to, seconds);
      return;
    }
    // Fallback: stepped in the ticker (see applyFallbackVolume).
    this.fallbackTarget = to;
    this.fallbackStep =
      seconds > 0 ? MUSIC_TUNING.TICK_MS / 1000 / seconds : 1;
    this.applyFallbackVolume();
  }

  private fallbackLevel = 0;
  private fallbackTarget = 0;
  private fallbackStep = 1;

  private applyFallbackVolume(): void {
    if (this.webAudio) return;
    const d = this.fallbackTarget - this.fallbackLevel;
    const step = Math.max(0.001, this.fallbackStep);
    if (Math.abs(d) <= step) this.fallbackLevel = this.fallbackTarget;
    else this.fallbackLevel += Math.sign(d) * step;
    for (const deck of this.decks) {
      const v = clamp01(this.volume * this.fallbackLevel * deck.fade);
      try {
        deck.el.volume = v;
      } catch {
        /* detached element */
      }
    }
  }

  /** Push the pure score function onto the level node. */
  private applyLevel(): void {
    if (!this.webAudio) {
      this.applyFallbackVolume();
      return;
    }
    const settings: ScoreSettings = {
      ...defaultScoreSettings(this.volume),
      battleWindowSec: battleWindowFor(this.speed),
    };
    const target = musicGain(this.time, this.battles, this.stats, settings);
    this.ramp(this.levelGain?.gain ?? null, target, MUSIC_TUNING.LEVEL_RAMP_SEC);
  }

  private setDeckFade(deck: Deck, to: number, seconds: number): void {
    deck.fade = to;
    if (this.webAudio) this.ramp(deck.gain?.gain ?? null, to, seconds);
    else this.applyFallbackVolume();
  }

  private loadDeck(deck: Deck, slot: number): void {
    if (!this.plan) return;
    const track = trackAt(this.plan, slot);
    deck.track = track;
    deck.slot = slot;
    try {
      // Assigning src re-runs the media load algorithm, which resets
      // the position — so there is no currentTime to poke here, and
      // poking it before metadata arrives is exactly the kind of
      // InvalidStateError that would take the whole score down.
      deck.el.src = trackUrl(track);
      deck.el.load();
    } catch {
      this.giveUp();
    }
  }

  private playDeck(deck: Deck): void {
    try {
      const p = deck.el.play();
      if (p && typeof p.catch === "function") {
        p.catch((err: unknown) => {
          const name =
            err && typeof err === "object" && "name" in err
              ? String((err as { name?: unknown }).name)
              : "";
          // NotAllowedError = the gesture did not count. Stay enabled
          // and silent; the next Play press tries again. Anything else
          // (NotSupportedError: 404 / undecodable) is terminal.
          if (name === "NotAllowedError" || name === "AbortError") return;
          this.giveUp();
        });
      }
    } catch {
      // jsdom throws outright; a browser never does.
      this.giveUp();
    }
  }

  private pauseDeck(deck: Deck): void {
    try {
      deck.el.pause();
    } catch {
      /* nothing to pause */
    }
    deck.fade = 0;
    if (this.webAudio && deck.gain) deck.gain.gain.value = 0;
  }

  /* ---- loop rotation --------------------------------------------- */

  private deckDuration(deck: Deck): number {
    const reported = deck.el.duration;
    if (Number.isFinite(reported) && reported > 0) return reported;
    return deck.track?.duration ?? 0;
  }

  private beginCrossfade(slotOverride?: number): void {
    if (this.decks.length < 2 || this.crossfading) return;
    const from = this.decks[this.active];
    const to = this.decks[1 - this.active];
    const slot = slotOverride ?? from.slot + 1;
    if (to.slot !== slot || !to.track) this.loadDeck(to, slot);
    this.crossfading = true;
    this.playDeck(to);
    this.setDeckFade(to, 1, MUSIC_TUNING.CROSSFADE_SEC);
    this.setDeckFade(from, 0, MUSIC_TUNING.CROSSFADE_SEC);
    this.active = 1 - this.active;
    this.opts.onTrackChange?.(to.track);
    const outgoing = from;
    setTimeout(
      () => {
        if (this.disposed) return;
        this.crossfading = false;
        if (this.decks[this.active] !== outgoing) this.pauseDeck(outgoing);
      },
      Math.round(MUSIC_TUNING.CROSSFADE_SEC * 1000) + 40,
    );
  }

  private startTicking(): void {
    if (this.tick !== null) return;
    this.tick = setInterval(() => this.onTick(), MUSIC_TUNING.TICK_MS);
  }

  private stopTicking(): void {
    if (this.tick === null) return;
    clearInterval(this.tick);
    this.tick = null;
  }

  private onTick(): void {
    if (this.disposed || this.failed) return;
    // Also advances the fallback fade one step — exactly one per tick,
    // which is what makes the fade last FADE_*_SEC there too.
    this.applyLevel();
    if (!this.playing || this.crossfading) return;
    const deck = this.decks[this.active];
    if (!deck || !deck.track) return;
    const duration = this.deckDuration(deck);
    if (!(duration > 0)) return;
    const remaining = duration - deck.el.currentTime;
    if (remaining <= MUSIC_TUNING.CROSSFADE_SEC) {
      this.beginCrossfade();
      return;
    }
    // Give the next deck a head start so it is buffered by the seam.
    if (remaining <= MUSIC_TUNING.PRELOAD_LEAD_SEC) {
      const next = this.decks[1 - this.active];
      if (next.slot !== deck.slot + 1) this.loadDeck(next, deck.slot + 1);
    }
  }
}

/* ============================================================
 * React binding
 * ============================================================ */

export interface ReplayMusicApi {
  enabled: boolean;
  volume: number;
  /** False once an asset failed: the control renders itself inert. */
  available: boolean;
  /** What is playing right now, for the control's tooltip. */
  track: MusicTrack | null;
  setEnabled: (enabled: boolean) => void;
  setVolume: (volume: number) => void;
  /** MUST be called from the play/pause click handler — that click is
   *  the user gesture the browser demands before audio can start. */
  setPlaying: (playing: boolean) => void;
}

export function useReplayMusic({
  playback,
  myRace,
  gameId,
  time,
  speed,
}: {
  playback: MapPlayback | null;
  myRace?: string | null;
  gameId?: string | null;
  time: number;
  speed: number;
}): ReplayMusicApi {
  // Server and first client render must agree, so the stored
  // preference is read in an effect rather than in the initialiser —
  // localStorage and matchMedia do not exist during SSR.
  const [prefs, setPrefs] = useState<MusicPrefs>({
    enabled: true,
    volume: MUSIC_TUNING.DEFAULT_VOLUME,
  });
  const [available, setAvailable] = useState(true);
  const [track, setTrack] = useState<MusicTrack | null>(null);
  const engineRef = useRef<ReplayMusicEngine | null>(null);

  const seed = useMemo(() => musicSeed(gameId, playback), [gameId, playback]);
  const plan = useMemo(() => musicPlan(myRace, seed), [myRace, seed]);

  useEffect(() => {
    const engine = new ReplayMusicEngine({
      onUnavailable: () => setAvailable(false),
      onTrackChange: (t) => setTrack(t),
    });
    engineRef.current = engine;
    setPrefs(loadMusicPrefs());
    return () => {
      engineRef.current = null;
      engine.dispose();
    };
  }, []);

  useEffect(() => {
    engineRef.current?.setPlan(plan);
    // Keep the tooltip on whatever is actually playing; only reset it
    // when the current track is not part of this plan at all.
    setTrack((cur) => {
      const mine =
        cur !== null &&
        (plan.intro.some((t) => t.id === cur.id) ||
          plan.beds.some((t) => t.id === cur.id));
      return mine ? cur : trackAt(plan, 0);
    });
  }, [plan]);
  useEffect(() => {
    engineRef.current?.setPlayback(playback);
  }, [playback]);
  useEffect(() => {
    engineRef.current?.setTime(time);
  }, [time]);
  useEffect(() => {
    engineRef.current?.setSpeed(speed);
  }, [speed]);
  useEffect(() => {
    engineRef.current?.setVolume(prefs.volume);
  }, [prefs.volume]);
  useEffect(() => {
    engineRef.current?.setEnabled(prefs.enabled);
  }, [prefs.enabled]);

  const setEnabled = useCallback((next: boolean) => {
    // Synchronous, inside the click handler: if the replay is already
    // running this is the gesture that starts the audio. Going through
    // the effect above instead would put a commit between the two.
    engineRef.current?.setEnabled(next);
    setPrefs((prev) => {
      const merged = { ...prev, enabled: next };
      saveMusicPrefs(merged);
      return merged;
    });
  }, []);

  const setVolume = useCallback((next: number) => {
    const v = clamp01(next);
    engineRef.current?.setVolume(v);
    setPrefs((prev) => {
      const merged = { ...prev, volume: v };
      saveMusicPrefs(merged);
      return merged;
    });
  }, []);

  const setPlaying = useCallback((next: boolean) => {
    engineRef.current?.setPlaying(next);
  }, []);

  return useMemo(
    () => ({
      enabled: prefs.enabled,
      volume: prefs.volume,
      available,
      track,
      setEnabled,
      setVolume,
      setPlaying,
    }),
    [prefs.enabled, prefs.volume, available, track, setEnabled, setVolume, setPlaying],
  );
}
