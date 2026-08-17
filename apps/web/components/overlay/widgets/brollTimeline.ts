import type {
  StudioBrollClip,
  StudioBrollPlayback,
} from "@/lib/multichat/useStudioState";

export interface BrollTimelinePosition {
  /** Index in the normalized clip library. */
  clipIndex: number;
  /** Position in the deterministic ordered/shuffled cycle. */
  cursor: number;
  /** Milliseconds elapsed inside the selected clip. */
  offsetMs: number;
  /** Milliseconds until every connected player should switch clips. */
  remainingMs: number;
}

/**
 * One deterministic Fisher-Yates order shared by every independent player.
 * The playlist repeats this complete order; because it is a permutation, a
 * cycle seam cannot repeat a clip when the library has more than one item.
 *
 * Keep the PRNG/procedure in lockstep with the API service's protocol helper.
 */
export function createBrollPlaybackOrder(
  clipCount: number,
  shuffle: boolean,
  seed: number,
): number[] {
  const count = Math.max(0, Math.floor(Number(clipCount) || 0));
  const order = Array.from({ length: count }, (_, index) => index);
  if (!shuffle || count < 2) return order;

  let state = Number(seed) >>> 0;
  const random = () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let value = state;
    value = Math.imul(value ^ (value >>> 15), value | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
    return ((value ^ (value >>> 14)) >>> 0) / 4_294_967_296;
  };
  for (let index = order.length - 1; index > 0; index -= 1) {
    const swap = Math.floor(random() * (index + 1));
    [order[index], order[swap]] = [order[swap], order[index]];
  }
  return order;
}

/**
 * Resolve the exact shared clip and offset for a wall-clock instant. A full
 * cycle always has the same duration regardless of shuffle order, so even a
 * Browser Source reconnecting days later needs at most one pass over the
 * (bounded) library.
 */
export function resolveBrollTimeline(
  clips: readonly StudioBrollClip[],
  shuffle: boolean,
  playback: StudioBrollPlayback,
  nowMs: number = Date.now(),
): BrollTimelinePosition | null {
  if (clips.length === 0) return null;
  const order = createBrollPlaybackOrder(clips.length, shuffle, playback.seed);
  let cursor = normalizeCursor(playback.cursor, clips.length);
  const totalMs = clips.reduce(
    (sum, clip) => sum + clipDurationMs(clip),
    0,
  );
  if (totalMs <= 0) return null;

  const safeNow = Number.isFinite(nowMs) ? Number(nowMs) : playback.epochMs;
  let elapsedMs = Math.max(0, safeNow - playback.epochMs) % totalMs;
  for (let step = 0; step < clips.length; step += 1) {
    const clipIndex = order[cursor];
    const durationMs = clipDurationMs(clips[clipIndex]);
    if (elapsedMs < durationMs) {
      return {
        clipIndex,
        cursor,
        offsetMs: elapsedMs,
        remainingMs: durationMs - elapsedMs,
      };
    }
    elapsedMs -= durationMs;
    cursor = (cursor + 1) % clips.length;
  }

  // Floating-point modulo should make this unreachable, but returning the
  // anchored clip keeps malformed legacy input fail-safe rather than blank.
  const clipIndex = order[cursor];
  const remainingMs = clipDurationMs(clips[clipIndex]);
  return { clipIndex, cursor, offsetMs: 0, remainingMs };
}

/**
 * Old API snapshots had only `skipNonce`. Epoch zero makes their schedule
 * deterministic from the Unix clock, so separately mounted sources still
 * agree; the nonce supplies a shared cursor until the next server write mints
 * an authoritative anchor.
 */
export function effectiveBrollPlayback(
  playback: StudioBrollPlayback | undefined,
  skipNonce: number,
  clipCount: number,
): StudioBrollPlayback {
  if (playback) return playback;
  return {
    epochMs: 0,
    revision: Math.max(0, Math.floor(Number(skipNonce) || 0)),
    seed: 0,
    cursor: normalizeCursor(skipNonce, clipCount),
  };
}

function clipDurationMs(clip: StudioBrollClip): number {
  return Math.max(1, (clip.endSeconds - clip.startSeconds) * 1000);
}

function normalizeCursor(cursor: number, count: number): number {
  if (count <= 0) return 0;
  const integer = Math.max(0, Math.floor(Number(cursor) || 0));
  return integer % count;
}
