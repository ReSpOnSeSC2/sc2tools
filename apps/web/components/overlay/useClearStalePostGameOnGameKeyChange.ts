"use client";

import { useEffect } from "react";
import type { LiveGameEnvelope, LiveGamePayload } from "./types";

/**
 * Clear the cached post-game ``LiveGamePayload`` (``live``) when the
 * agent's pre/in-game envelope identifies a NEW match. Two signals,
 * checked in priority order:
 *
 *   1. **gameKey rotation** — the agent stamps a fresh
 *      ``sorted_player_names|started_at_ms`` key on every match's
 *      first active-phase event. When the new envelope's key differs
 *      from the live payload's key, the live payload belongs to a
 *      finished match and must be dropped before the OpponentWidget
 *      pins it onto the next match.
 *   2. **Opponent identity change (defense-in-depth)** — the agent's
 *      state machine prior to 2026-05-13 could re-use the previous
 *      match's ``game_key`` when SC2 jumped MATCH_ENDED → MATCH_STARTED
 *      faster than one poll window (the loading screen flipped by in
 *      under ~1 s and the MATCH_STARTED branch's ``if
 *      _current_game_key is None`` guard kept the stale id). Older
 *      agent versions still in the wild therefore can produce two
 *      back-to-back matches with the SAME gameKey but DIFFERENT
 *      opponent names. We fall back to the opponent-name check so a
 *      streamer running an old agent build still self-heals on the
 *      client — the post-game card snaps off, the scouting widget
 *      unblocks (its ``isRealPostGame`` early-return was the visible
 *      consequence of this bug), and the live envelope renders the
 *      new opponent's data.
 *
 * Both checks share one effect so we only call ``setLive(null)`` once
 * per render even when both signals trip together (the common case
 * once the agent fix ships).
 *
 * This is the gameKey-aware successor to the older ``match_loading``-
 * only effect, which only fired on a single lifecycle phase and
 * missed three real failure modes:
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
    // Primary signal: the agent emitted a fresh gameKey for this
    // match. Both sides must carry a string-typed key for the check
    // to be meaningful; an absent key on either side falls through
    // to the opponent-name fallback below.
    const lgKey = liveGame.gameKey;
    const liveKey = live.gameKey;
    const gameKeysDiffer =
      typeof lgKey === "string"
      && typeof liveKey === "string"
      && lgKey !== liveKey;
    // Fallback signal: opponent identity changed. Lower-case +
    // trimmed so a casing tweak from one ingest source to another
    // (Pulse profile name vs. replay header name) doesn't false-
    // positive. We require BOTH sides to have a non-empty name so a
    // pre-resolution envelope (no ``opponent.name`` yet) cannot
    // accidentally yank the live payload on the very first tick of a
    // new match.
    const lgOpp =
      liveGame.opponent
      && typeof liveGame.opponent.name === "string"
        ? liveGame.opponent.name.trim().toLowerCase()
        : "";
    const liveOpp =
      typeof live.oppName === "string" ? live.oppName.trim().toLowerCase() : "";
    const opponentNamesDiffer =
      lgOpp.length > 0 && liveOpp.length > 0 && lgOpp !== liveOpp;
    if (!gameKeysDiffer && !opponentNamesDiffer) return;
    setLive(null);
  }, [liveGame, live, setLive]);
}
