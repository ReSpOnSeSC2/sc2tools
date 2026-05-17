/**
 * Per-trigger dedupe state for ``useVoiceReadout``.
 *
 * Each readout trigger (scouting / matchStart / matchEnd / cheese) is
 * fingerprinted from the live payload (see ``useVoiceReadout.builders``)
 * and stamped on a ref the moment its line is queued. Subsequent
 * payloads with the same fingerprint are dropped before they reach the
 * speech engine — that is the contract the hook commits to: "the same
 * opponent identity within the same gesture-unlocked session is spoken
 * at most once."
 *
 * The dedup state lives in its own module because TWO code paths must
 * share the exact same source of truth:
 *
 *   1. The post-game payload effect, which sets the fingerprints when
 *      it speaks.
 *   2. The live-envelope match-transition effect, which clears them
 *      when a genuinely new match arrives so a back-to-back rematch
 *      against the same opponent still gets its own readout.
 *
 * Co-locating these refs and the wipe helper here makes it impossible
 * for one site to forget a key when the contract changes, and it lets
 * ``useVoiceReadout.ts`` stay under the project's per-file ceiling.
 *
 * Everything in this module is also React-free at the leaf:
 * ``consumeFingerprint`` is a pure function so the builders' unit tests
 * (and any future ``shouldSpeak`` integration check) can exercise the
 * dedup decision without spinning up a renderer.
 */

import { useMemo, useRef, type MutableRefObject } from "react";

/**
 * Per-trigger dedupe primitive. Returns ``true`` when ``key`` is fresh
 * — and stamps it on ``ref`` — and ``false`` when ``key`` matches the
 * previously-recorded fingerprint (or is empty). Lets each trigger
 * collapse to a one-line guard at the call site instead of repeating
 * the "load, compare, stamp" dance four times.
 *
 * Empty / falsy keys are always rejected so a malformed payload (no
 * oppName, no race) cannot silently win the dedup race against the
 * next, well-formed emit.
 */
export function consumeFingerprint(
  ref: MutableRefObject<string | null>,
  key: string,
): boolean {
  if (!key || key === ref.current) return false;
  ref.current = key;
  return true;
}

/**
 * The four dedup refs the hook tracks, one per trigger. Bundled into
 * an object so the orchestrator can pass the whole bundle to helpers
 * (wipe, match-transition reset) without re-listing each ref.
 */
export interface ScoutingFingerprints {
  scouting: MutableRefObject<string | null>;
  matchStart: MutableRefObject<string | null>;
  matchEnd: MutableRefObject<string | null>;
  cheese: MutableRefObject<string | null>;
}

/**
 * Allocate the four dedup refs that back ``useVoiceReadout``'s
 * speak-at-most-once contract. The returned bundle is memoised so it's
 * referentially stable across renders — passing it into effect deps
 * is safe.
 */
export function useScoutingFingerprints(): ScoutingFingerprints {
  const scouting = useRef<string | null>(null);
  const matchStart = useRef<string | null>(null);
  const matchEnd = useRef<string | null>(null);
  const cheese = useRef<string | null>(null);
  return useMemo(
    () => ({ scouting, matchStart, matchEnd, cheese }),
    [],
  );
}

/**
 * Wipe every dedup ref in the bundle. Called on real match transitions
 * (envelope clears after a played match, or ``gameKey`` flips) so a
 * fresh match against the same opponent still gets its own readout.
 *
 * Must NOT be called on initial mount when nothing has been spoken
 * yet — doing so would invalidate the fingerprint the main payload
 * effect just stamped, causing the same line to fire twice on the next
 * effect run.
 */
export function resetScoutingFingerprints(fp: ScoutingFingerprints): void {
  fp.scouting.current = null;
  fp.matchStart.current = null;
  fp.matchEnd.current = null;
  fp.cheese.current = null;
}

/**
 * Narrower reset used when the opponent changes mid-pre-game. Only the
 * scouting + matchStart lines are gated on opponent identity; matchEnd
 * and cheese fingerprints track different attributes and must survive
 * an opponent flip so a stale "Defeat. minus 24 MMR." cannot replay
 * because a *new* opponent reveal cleared its dedup key.
 */
export function resetPreGameFingerprints(fp: ScoutingFingerprints): void {
  fp.scouting.current = null;
  fp.matchStart.current = null;
}
