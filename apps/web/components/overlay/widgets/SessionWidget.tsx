"use client";

import type { LiveGamePayload } from "../types";
import { Dim, WidgetHeader, WidgetShell } from "../WidgetShell";

export type SessionSummary = {
  wins: number;
  losses: number;
  games: number;
  mmrStart?: number;
  mmrCurrent?: number;
};

/**
 * Today's W-L counter (and MMR delta when the agent has populated
 * ``myMmr`` on the games it uploads).
 *
 * Two data sources are accepted, in priority order:
 *
 *  1. ``session`` — pushed by the cloud over the ``overlay:session``
 *     socket event. Fully cloud-derived, fires the moment a new game
 *     lands in Mongo, so the widget works whether or not the local
 *     desktop agent is currently running pre/post-game live events.
 *  2. ``live.session`` — the legacy path the agent's
 *     ``push_overlay_live`` posts when it parses a fresh replay. Used
 *     as a fallback so an older stack that still sends the merged
 *     payload keeps rendering.
 *
 * Showing the panel even at 0W-0L (when the cloud says the streamer
 * has played zero games today but a session aggregate is available) is
 * intentional: it gives the streamer immediate visual confirmation
 * that the Browser Source is wired up correctly, instead of staying
 * blank until the first game finishes.
 */
export function SessionWidget({
  live,
  session,
}: {
  live: LiveGamePayload | null;
  session?: SessionSummary | null;
}) {
  const s = session ?? live?.session;
  if (!s) return null;
  const delta =
    typeof s.mmrCurrent === "number" && typeof s.mmrStart === "number"
      ? s.mmrCurrent - s.mmrStart
      : null;
  const deltaColor =
    delta == null ? "inherit" : delta >= 0 ? "#3ec07a" : "#ff6b6b";
  return (
    <WidgetShell slot="top-right" accent="neutral" visible width={480}>
      <WidgetHeader>
        <span style={{ fontSize: 15 }}>Today</span>
        <span style={{ fontSize: 18, fontWeight: 700, fontVariantNumeric: "tabular-nums" }}>
          {s.wins}W &ndash; {s.losses}L
        </span>
      </WidgetHeader>
      {delta != null && (
        <div
          style={{
            marginTop: 8,
            display: "flex",
            justifyContent: "space-between",
            fontSize: 13,
            alignItems: "baseline",
          }}
        >
          <Dim>MMR delta</Dim>
          <span
            style={{
              color: deltaColor,
              fontWeight: 700,
              fontSize: 16,
              fontVariantNumeric: "tabular-nums",
            }}
          >
            {delta >= 0 ? "+" : ""}
            {delta}
          </span>
        </div>
      )}
    </WidgetShell>
  );
}
