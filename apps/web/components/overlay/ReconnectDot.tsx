"use client";

/**
 * Broadcast-safe "connection degraded" indicator for OBS overlays.
 *
 * Design constraints (this renders ON STREAM):
 *  - tiny (6px), low-opacity, no text, no layout shift;
 *  - amber rather than red — "data may be stale", not "panic";
 *  - static (no animation) so reduced-motion needs no special case
 *    and it never draws the audience's eye;
 *  - shown only after the connection has failed for five seconds,
 *    including refused handshakes before the first widget arrives.
 */
export function ReconnectDot() {
  return (
    <span
      aria-hidden
      data-testid="overlay-reconnect-dot"
      style={{
        position: "absolute",
        top: 8,
        right: 8,
        width: 6,
        height: 6,
        borderRadius: "50%",
        background: "#e6b450",
        opacity: 0.5,
        pointerEvents: "none",
        zIndex: 50,
      }}
    />
  );
}
