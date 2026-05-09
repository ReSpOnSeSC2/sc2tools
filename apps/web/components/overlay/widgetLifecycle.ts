// Per-widget visibility lifecycle for the OBS overlay.
//
// The cloud broadcasts a single `overlay:live` payload per game and a
// separate `overlay:session` payload for the W-L counter. Each widget
// then lives on screen for its own natural duration — the SPA's event
// registry baked these into one giant queue; here they're a single
// declarative table the React clients consume.
//
// Production rules (mirroring the legacy SPA):
//   • Event widgets (match-result, scouting, streak, …) — auto-hide
//     after their per-widget duration so the streamer's scene clears
//     between games.
//   • Persistent widgets (session, topbuilds) — stay on screen
//     indefinitely. The session card is a HUD; the top-builds tile
//     grid is reference info that should not flicker.
//   • Opponent dossier — auto-hides after a long idle window so a
//     streamer who steps away doesn't return to a stale opponent
//     pinned to their stream.
//
// Test mode rules:
//   • Every widget — including the persistent ones — is capped at a
//     short duration so a streamer can preview a Test fire from
//     Settings → Overlay without it sitting on their scene forever.

export type WidgetId =
  | "opponent"
  | "match-result"
  | "post-game"
  | "mmr-delta"
  | "streak"
  | "cheese"
  | "rematch"
  | "rival"
  | "rank"
  | "meta"
  | "topbuilds"
  | "fav-opening"
  | "best-answer"
  | "scouting"
  | "session";

export const ALL_WIDGETS: ReadonlyArray<WidgetId> = [
  "opponent",
  "match-result",
  "post-game",
  "mmr-delta",
  "streak",
  "cheese",
  "rematch",
  "rival",
  "rank",
  "meta",
  "topbuilds",
  "fav-opening",
  "best-answer",
  "scouting",
  "session",
];

/**
 * How long each widget stays on screen in production after the
 * `overlay:live` payload (or, for `session`, the dedicated
 * `overlay:session` event) lands. `null` = persistent — the widget
 * stays until the socket disconnects.
 *
 * Numbers are tuned to mirror the legacy SPA's `EVENT_REGISTRY`
 * defaults so streamers swapping over from the local app see the same
 * cadence.
 */
export const WIDGET_DURATION_MS: Record<WidgetId, number | null> = {
  // Opponent dossier — pinned visibly during the active phases of a
  // match (loading / started / in-progress, see `useWidgetVisibility`),
  // then naturally hides 22s after `match_ended` so the streamer's
  // scene clears for the next queue. The legacy 6-minute duration was
  // a hack to bridge "queue-into-next-match" gaps, but the cloud now
  // clears `live` on `match_loading` (see
  // `useClearStalePostGameOnNewMatch`) so the dossier is replaced by
  // the new opponent's data the moment SC2 reports the next loading
  // screen. Six minutes was just leaving stale data on the OBS scene.
  "opponent": 22 * 1000,
  // Event chips — short, stream-friendly durations.
  // Match-result chip ("VICTORY" / "DEFEAT" banner) trimmed from 15s
  // to 8s on streamer feedback: the result is decisive enough at a
  // glance that 15s read as lingering on a finished game; 8s lines up
  // with the streak chip cadence.
  "match-result": 8 * 1000,
  "post-game": 16 * 1000,
  "mmr-delta": 10 * 1000,
  "streak": 8 * 1000,
  "cheese": 18 * 1000,
  "rematch": 15 * 1000,
  "rival": 16 * 1000,
  "rank": 12 * 1000,
  "meta": 12 * 1000,
  "fav-opening": 18 * 1000,
  "best-answer": 18 * 1000,
  "scouting": 22 * 1000,
  // Persistent panels — HUDs that should stay on screen.
  "topbuilds": null,
  "session": null,
};

/**
 * Test-mode duration cap. Used when an `overlay:live` (or
 * `overlay:session`) payload arrives carrying `isTest: true` from
 * the /v1/overlay-events/test route. Every widget — including the
 * normally-persistent ones — auto-hides after this so the preview
 * never lingers on the streamer's scene.
 */
export const TEST_DURATION_MS = 20 * 1000;

/**
 * Resolve the visibility duration for a widget given the current
 * live payload's test flag. Production widgets keep their natural
 * duration; test fires cap everything (including `null` widgets)
 * at the test-mode duration.
 *
 * @param id    The widget id.
 * @param isTest True when the payload was emitted by the Test route.
 * @returns      Milliseconds to remain visible. `null` = persistent.
 */
export function resolveWidgetDurationMs(
  id: WidgetId,
  isTest: boolean,
): number | null {
  const prod = WIDGET_DURATION_MS[id];
  if (!isTest) return prod;
  if (prod === null) return TEST_DURATION_MS;
  return Math.min(prod, TEST_DURATION_MS);
}
