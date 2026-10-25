// Build check-in → randomizer gate (pure helpers).
//
// When the streamer can check in a build at the loading screen, the
// server holds the OBS randomizer for a few seconds and tells every
// overlay source about it on ``overlay:buildIntent``. A declaration
// during the hold means the reveal never runs; "Roll now", "Not now",
// the hold running out or the match starting let it spin as usual.
//
// The server only sends ``holdRemainingMs``. Each client turns that into
// a LOCAL deadline (receipt time + remaining) so an OBS PC with a skewed
// clock still releases on time — server and browser clocks are never
// compared.

import type {
  LiveGamePhase,
  OverlayBuildIntent,
  RandomizerIntentGate,
} from "./types";

/**
 * How long a real game's spin waits for the server's check-in state
 * before rolling as it always has, counted from when the match could
 * first spin. Bounded so a server without a live check-in record (or a
 * lost event) never blocks the reveal for long.
 */
export const RANDOMIZER_INTENT_WAIT_MS = 1_500;

/**
 * Defensive cap on a hold read off the wire. The server's hold is a few
 * seconds and match start ends it anyway; this only stops a malformed
 * value from parking the randomizer for the whole loading screen.
 */
export const MAX_RANDOMIZER_HOLD_MS = 30_000;

/** Matches the server's live ``gameKey`` length bound. */
const MAX_GAME_KEY_LENGTH = 400;

/** Recent games kept per client; only the current one really matters. */
const LEDGER_SIZE = 8;

/** Latest check-in state of one game, with the hold as a local deadline. */
export interface BuildIntentEntry {
  suppressRandomizer: boolean;
  /** Local ``Date.now()`` deadline of a pending hold; 0 when none. */
  holdDeadlineMs: number;
  randomizer?: OverlayBuildIntent["randomizer"];
}

/** Per-gameKey check-in state, oldest first. */
export type BuildIntentLedger = ReadonlyMap<string, BuildIntentEntry>;

export const EMPTY_BUILD_INTENT_LEDGER: BuildIntentLedger = new Map();

/** Validate an ``overlay:buildIntent`` payload; null for anything unusable. */
export function parseOverlayBuildIntent(msg: unknown): OverlayBuildIntent | null {
  if (!msg || typeof msg !== "object") return null;
  const { gameKey, suppressRandomizer, holdRemainingMs, randomizer } = msg as Record<string, unknown>;
  if (typeof gameKey !== "string" || gameKey.length === 0
    || gameKey.length > MAX_GAME_KEY_LENGTH) return null;
  const hold = typeof holdRemainingMs === "number" && Number.isFinite(holdRemainingMs)
    ? Math.min(Math.max(holdRemainingMs, 0), MAX_RANDOMIZER_HOLD_MS)
    : 0;
  const candidate = randomizer && typeof randomizer === "object" && !Array.isArray(randomizer)
    ? randomizer as Record<string, unknown> : null;
  const saved = candidate && typeof candidate.key === "string" && candidate.key.trim()
    && candidate.key.length <= 200 && typeof candidate.name === "string" && candidate.name.trim()
    && candidate.name.length <= 500 && (candidate.source === "catalog" || candidate.source === "custom")
    ? { key: candidate.key, name: candidate.name, source: candidate.source } as NonNullable<OverlayBuildIntent["randomizer"]> : null;
  return { gameKey, suppressRandomizer: suppressRandomizer === true, holdRemainingMs: hold,
    ...(saved ? { randomizer: saved } : {}) };
}

/**
 * Store the latest state for ``event.gameKey``. Each event replaces the
 * previous one for that game (a release arrives as ``holdRemainingMs: 0``),
 * and the hold deadline is anchored to the local receipt time.
 */
export function recordBuildIntent(
  ledger: BuildIntentLedger,
  event: OverlayBuildIntent,
  receivedAtMs: number,
): BuildIntentLedger {
  const next = new Map(ledger);
  next.delete(event.gameKey);
  next.set(event.gameKey, {
    suppressRandomizer: event.suppressRandomizer,
    holdDeadlineMs: event.holdRemainingMs > 0 ? receivedAtMs + event.holdRemainingMs : 0,
    ...(event.randomizer ? { randomizer: event.randomizer } : {}),
  });
  while (next.size > LEDGER_SIZE) {
    const oldest = next.keys().next().value;
    if (oldest === undefined) break;
    next.delete(oldest);
  }
  return next;
}

/** The gate ``RandomizerWidget`` needs for one game; null without a real key. */
export function randomizerIntentGate(
  ledger: BuildIntentLedger,
  gameKey: string | null,
): RandomizerIntentGate | null {
  if (!gameKey) return null;
  const entry = ledger.get(gameKey);
  if (!entry) {
    return { gameKey, seen: false, suppressRandomizer: false, holdDeadlineMs: 0 };
  }
  return { gameKey, seen: true, ...entry };
}

/**
 * How long a real game's spin must still wait: 0 = spin now, a positive
 * value = check again after that many ms, null = blocked until the
 * check-in state changes (a declaration suppresses the randomizer).
 *
 *  1. Until state for this game has been seen, wait at most
 *     ``RANDOMIZER_INTENT_WAIT_MS`` from ``waitStartedAtMs`` — when the
 *     match first had everything it needs to spin (start key, concrete
 *     matchup, config).
 *  2. A suppressed game never spins.
 *  3. A pending hold delays the spin unless the match already started.
 */
export function randomizerSpinDelayMs({
  gate,
  phase,
  waitStartedAtMs,
  nowMs,
}: {
  gate: Pick<RandomizerIntentGate, "seen" | "suppressRandomizer" | "holdDeadlineMs"> | null;
  phase: LiveGamePhase | null | undefined;
  waitStartedAtMs: number;
  nowMs: number;
}): number | null {
  if (!gate?.seen) {
    return Math.max(0, waitStartedAtMs + RANDOMIZER_INTENT_WAIT_MS - nowMs);
  }
  if (gate.suppressRandomizer) return null;
  if (phase === "match_started" || phase === "match_in_progress") return 0;
  return Math.max(0, gate.holdDeadlineMs - nowMs);
}

/** The moment a match's randomizer window must run its full duration from. */
export interface RandomizerWindowAnchor {
  /** Start trigger key (``game:<gameKey>``) the anchor belongs to. */
  key: string;
  atMs: number;
}

/**
 * Anchor the randomizer's visibility window to the actual spin start, or —
 * before the spin — to a pending hold's end, so a held reveal is never
 * clipped by a window armed when the match's start key first appeared.
 * Test fires are never held and keep their capped window.
 */
export function randomizerWindowAnchor(
  triggerKey: string | null,
  lastSpin: { triggerKey: string; startedAtMs: number } | null,
  gate: RandomizerIntentGate | null,
): RandomizerWindowAnchor | null {
  if (!triggerKey?.startsWith("game:")) return null;
  if (lastSpin?.triggerKey === triggerKey) {
    return { key: triggerKey, atMs: lastSpin.startedAtMs };
  }
  if (gate?.seen && !gate.suppressRandomizer && gate.holdDeadlineMs > 0) {
    return { key: triggerKey, atMs: gate.holdDeadlineMs };
  }
  return null;
}
