"use client";

import { useEffect } from "react";
import type { LiveGameEnvelope, LiveGamePayload } from "./types";

/**
 * Clear the cached post-game ``LiveGamePayload`` (``live``) when the
 * agent's pre/in-game envelope reports a DIFFERENT gameKey than the
 * one ``live`` carries. This is the gameKey-aware successor to the
 * older ``match_loading``-only effect, which only fired on a single
 * lifecycle phase and missed three real failure modes:
 *
 *   1. **Fast loading screen.** SC2's loading screen can finish
 *      before the agent's poll observes ``ScreenLoading``. The bridge
 *      then jumps straight from MATCH_ENDED → MATCH_IN_PROGRESS for
 *      the next game; the old hook never fired and the previous
 *      opponent stayed pinned to the Opponent widget.
 *   2. **Server / region switch.** Switching NA → EU goes through
 *      MENU (which clears ``liveGame``), but the post-game ``live``
 *      from the last NA match lingers because no ``match_loading``
 *      fires until the new EU match starts.
 *   3. **Reconnect mid-match.** The Browser Source reconnects after
 *      a transient drop and the broker's cached envelope is already
 *      ``match_in_progress`` — the original ``match_loading`` was
 *      lost. The cloud emits a synthetic ``match_loading`` prelude
 *      (see ``LiveGameBroker.replayLatestForOverlay``) for backward
 *      compat, but the gameKey-change effect catches the mismatch
 *      directly without depending on that prelude.
 *
 * Shared by both overlay clients (``OverlayClient`` for the all-in-one
 * URL and ``OverlayWidgetClient`` for the per-widget URL) so the stale-
 * clear behaviour stays consistent regardless of which Browser Source
 * the streamer wired into OBS.
 */
export function useClearStalePostGameOnGameKeyChange(
  liveGame: LiveGameEnvelope | null,
  live: LiveGamePayload | null,
  setLive: (next: LiveGamePayload | null) => void,
) {
  useEffect(() => {
    if (!liveGame || !live) return;
    const lgKey = liveGame.gameKey;
    const liveKey = live.gameKey;
    // No gameKey on either side → no signal, do nothing. The
    // backwards-compat path (cloud running an older derivation that
    // never stamped gameKey) was never observed in practice; we leave
    // ``live`` alone rather than risk yanking it on every envelope
    // tick of an active match.
    if (typeof lgKey !== "string" || typeof liveKey !== "string") return;
    if (lgKey === liveKey) return;
    setLive(null);
  }, [liveGame, live, setLive]);
}
