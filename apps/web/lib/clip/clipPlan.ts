/**
 * clipPlan — the pure rules behind "Make a clip" on the map replay.
 *
 * Everything here is deterministic arithmetic so the recorder, the
 * dialog and the tests agree on exactly which game moments become
 * which frames:
 *
 *   range   a game-time window [start, end), at most 60 s, inside the
 *           game and inside the loaded playback section; by default the
 *           nearest detected fight (lib/gameTimeline ``detectBattles``)
 *           padded by 10 s either side
 *   frames  frame i shows game time ``start + i * speed / fps``; a
 *           range of D game seconds at speed s is D / s seconds of
 *           video, so ``round(D / s * fps)`` frames (at least one)
 *   caps    video ≤ 96 MB; GIF ≤ 20 s of output and ≤ 48 MB
 *
 * Clips are rendered and encoded in the browser only: no upload, no
 * server encoder, no per-use cost.
 */

import { detectBattles } from "@/lib/gameTimeline";

export const CLIP_MAX_SECONDS = 60;
export const CLIP_PAD_SECONDS = 10;
/** Shortest range worth recording. */
export const CLIP_MIN_SECONDS = 1;
export const CLIP_SPEEDS = [1, 2, 4] as const;
export type ClipSpeed = (typeof CLIP_SPEEDS)[number];

export const CLIP_SIZES = {
  landscape: { width: 1280, height: 720, label: "1280×720" },
  square: { width: 1080, height: 1080, label: "1080×1080" },
} as const;
export type ClipSize = keyof typeof CLIP_SIZES;
export type ClipFormat = "video" | "gif";

export const VIDEO_FPS = 30;
export const GIF_FPS = 12;
/** Video bitrate requested from MediaRecorder; the browser may adapt it. */
export const VIDEO_BITS_PER_SECOND = 6_000_000;
export const VIDEO_MAX_BYTES = 96 * 1024 * 1024;
export const GIF_MAX_VIDEO_SECONDS = 20;
export const GIF_MAX_BYTES = 48 * 1024 * 1024;

export interface ClipRange { start: number; end: number }
export interface PlaybackWindow { start: number; end: number }

const finite = (value: number, fallback: number) => (Number.isFinite(value) ? value : fallback);

/**
 * Fit a requested range to the game, the loaded section and the
 * 60-second cap. The start wins: a too-long range is shortened at its
 * end, and a range starting outside the bounds slides inside.
 */
export function clampClipRange(range: ClipRange, gameLength: number, window?: PlaybackWindow | null): ClipRange {
  const lo = Math.max(0, window ? window.start : 0);
  const hi = Math.max(lo, Math.min(Math.max(0, finite(gameLength, 0)), window ? window.end : Infinity));
  const span = Math.min(CLIP_MAX_SECONDS, hi - lo);
  let start = Math.min(Math.max(finite(range.start, lo), lo), hi);
  let end = Math.min(Math.max(finite(range.end, start), start), hi, start + CLIP_MAX_SECONDS);
  if (end - start < Math.min(CLIP_MIN_SECONDS, span)) {
    end = Math.min(hi, start + Math.min(CLIP_MIN_SECONDS, span));
    start = Math.max(lo, end - Math.min(CLIP_MIN_SECONDS, span));
  }
  return { start, end };
}

/**
 * The default range: the fight nearest ``t`` from the playback's own
 * army-value rows, padded 10 s each side and capped at 60 s; with no
 * detected fight, 10 s either side of ``t``.
 */
export function defaultClipRange(
  stats: { me: readonly number[][]; opp: readonly number[][] },
  t: number,
  gameLength: number,
  window?: PlaybackWindow | null,
): ClipRange & { source: "fight" | "time" } {
  const rows = (side: readonly number[][]) => side.map((row) => ({ time: row[0], army_value: row[1] }));
  const fights = detectBattles(rows(stats.me), rows(stats.opp)).filter((fight) => !window || (fight.end >= window.start && fight.start <= window.end));
  let best: { start: number; end: number } | null = null;
  let bestDistance = Infinity;
  for (const fight of fights) {
    const distance = t < fight.start ? fight.start - t : t > fight.end ? t - fight.end : 0;
    if (distance < bestDistance) { best = fight; bestDistance = distance; }
  }
  if (best) {
    const start = best.start - CLIP_PAD_SECONDS;
    return { ...clampClipRange({ start, end: Math.min(best.end + CLIP_PAD_SECONDS, start + CLIP_MAX_SECONDS) }, gameLength, window), source: "fight" };
  }
  return { ...clampClipRange({ start: t - CLIP_PAD_SECONDS, end: t + CLIP_PAD_SECONDS }, gameLength, window), source: "time" };
}

/** Seconds of video a range becomes at ``speed``. */
export function clipVideoSeconds(range: ClipRange, speed: number): number {
  return Math.max(0, range.end - range.start) / (speed > 0 ? speed : 1);
}

/** Frames in a clip: one per 1/fps of video, never fewer than one. */
export function clipFrameCount(range: ClipRange, speed: number, fps: number): number {
  return Math.max(1, Math.round(clipVideoSeconds(range, speed) * fps));
}

/** Game time shown by frame ``index`` — strictly inside [start, end). */
export function clipFrameTime(range: ClipRange, speed: number, fps: number, index: number): number {
  return range.start + (index * (speed > 0 ? speed : 1)) / fps;
}

/** Whether a GIF of this range and speed stays within its cap. */
export function gifFits(range: ClipRange, speed: number): boolean {
  return clipVideoSeconds(range, speed) <= GIF_MAX_VIDEO_SECONDS + 1e-9;
}

/** Recorder formats in preference order: WebM VP9, VP8, any WebM, then MP4. */
export const VIDEO_MIME_PREFERENCE = [
  "video/webm;codecs=vp9",
  "video/webm;codecs=vp8",
  "video/webm",
  "video/mp4;codecs=avc1",
  "video/mp4",
] as const;

/** The first container the browser can record, or null for GIF only. */
export function pickVideoMime(isTypeSupported: ((mime: string) => boolean) | null | undefined): string | null {
  if (typeof isTypeSupported !== "function") return null;
  for (const mime of VIDEO_MIME_PREFERENCE) {
    try {
      if (isTypeSupported(mime)) return mime;
    } catch {
      // A throwing probe counts as unsupported.
    }
  }
  return null;
}

/** "sc2tools-clip-3m12s-3m42s.webm" — game times, never names. */
export function clipFileName(range: ClipRange, format: ClipFormat, mime?: string | null): string {
  const stamp = (seconds: number) => {
    const total = Math.max(0, Math.floor(seconds));
    return `${Math.floor(total / 60)}m${String(total % 60).padStart(2, "0")}s`;
  };
  const extension = format === "gif" ? "gif" : mime?.startsWith("video/mp4") ? "mp4" : "webm";
  return `sc2tools-clip-${stamp(range.start)}-${stamp(range.end)}.${extension}`;
}

/** "3:12" → 192; tolerant of "192" and surrounding spaces. Null when unreadable. */
export function parseClipClock(text: string): number | null {
  const value = text.trim();
  const clock = /^(\d{1,3}):([0-5]\d)$/.exec(value);
  if (clock) return Number(clock[1]) * 60 + Number(clock[2]);
  return /^\d{1,5}$/.test(value) ? Number(value) : null;
}
