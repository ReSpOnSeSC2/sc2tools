import profileRules from "@/lib/overlayProfileRules.json";

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
  | "session"
  | "randomizer"
  | "ghost-build"
  | "multichat"
  | "chat-highlight"
  | "chat-poll"
  | "chat-alerts"
  | "stream-goals"
  | "session-recap"
  | "stream-scene"
  | "chat-oracle"
  | "supporter-wall"
  | "clip-flag"
  | "lower-third"
  | "stats-ticker"
  | "countdown-timer"
  | "build-profile";

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
  "randomizer",
  "ghost-build",
  "multichat",
  "chat-highlight",
  "chat-poll",
  "chat-alerts",
  "stream-goals",
  "session-recap",
  "stream-scene",
  "chat-oracle",
  "supporter-wall",
  "clip-flag",
  "lower-third",
  "stats-ticker",
  "countdown-timer",
  "build-profile",
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
export const WIDGET_DURATION_MS: Record<WidgetId, number | null> = profileRules.widgetDurationMs;

/**
 * Test-mode duration cap. Used when an `overlay:live` (or
 * `overlay:session`) payload arrives carrying `isTest: true` from
 * the /v1/overlay-events/test route. Every widget — including the
 * normally-persistent ones — auto-hides after this so the preview
 * never lingers on the streamer's scene.
 */
export const TEST_DURATION_MS = 20 * 1000;

/**
 * Whether a live payload is intended for this Browser Source. Real
 * games and Test-all events have no discriminator and reach every
 * widget; a per-widget Test reaches only the selected source.
 */
export function payloadTargetsWidget(
  payload: { isTest?: boolean; testWidget?: string } | null,
  widget: WidgetId,
): boolean {
  return !payload?.isTest
    || !payload.testWidget
    || payload.testWidget === widget;
}

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
  options?: Record<string, { durationSec?: number | null }>,
): number | null {
  const seconds = options?.[id]?.durationSec;
  const prod = WIDGET_DURATION_MS[id] !== null && typeof seconds === "number" && profileRules.durationSeconds.includes(seconds)
    ? seconds * 1000 : WIDGET_DURATION_MS[id];
  if (!isTest) return prod;
  if (prod === null) return TEST_DURATION_MS;
  return Math.min(prod, TEST_DURATION_MS);
}

/**
 * Extend a start-only window so it runs its full duration from
 * ``anchorMs`` — the moment a held randomizer reveal can (or did) begin.
 * The window is first armed when the match's start key appears; a build
 * check-in hold can push the spin seconds later, and the two-act reveal
 * must still get its whole budget. Never shortens a window and never
 * reopens one that already closed (a late start stays unshown, as before).
 */
export function extendStartWindow(
  deadlineMs: number,
  anchorMs: number,
  durationMs: number,
  nowMs: number,
): number {
  if (deadlineMs <= nowMs) return deadlineMs;
  return Math.max(deadlineMs, anchorMs + durationMs);
}
