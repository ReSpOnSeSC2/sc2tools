"use client";

/**
 * DockClips — the clip-moment log for the Stream Dock: every moment
 * the engagement service flagged (chat spikes, notable game events),
 * newest first, with wall-clock timestamps and the chat lines that
 * caused it — a ready-made highlight shortlist for post-stream
 * editing. Live via ``overlay:engagement`` with the summary as boot
 * state (the dock host passes both through).
 */

import type { ClipMoment } from "@/lib/multichat/useEngagementState";

export function DockClips({ moments }: { moments: ReadonlyArray<ClipMoment> }) {
  if (moments.length === 0) {
    return (
      <p className="text-caption text-text-dim">
        No clip moments yet — when chat spikes or a big game moment
        lands, it's logged here with the time and what caused it.
      </p>
    );
  }
  return (
    <ul className="space-y-1.5">
      {moments.map((m) => (
        <li
          key={`${m.atMs}:${m.reason}`}
          className="rounded-md border border-border bg-bg-elevated px-2.5 py-1.5"
        >
          <div className="flex items-baseline gap-2">
            <span className="text-micro tabular-nums text-text-muted">
              {new Date(m.atMs).toLocaleTimeString([], {
                hour: "2-digit",
                minute: "2-digit",
                second: "2-digit",
              })}
            </span>
            <span
              className={`text-micro font-bold uppercase tracking-wider ${
                m.kind === "game-event" ? "text-accent-cyan" : "text-warning"
              }`}
            >
              {m.kind === "game-event" ? "Game" : "🔥 Chat"}
            </span>
          </div>
          <div className="mt-0.5 break-words text-caption text-text">
            {m.reason}
          </div>
          {m.sampleLines.length > 0 ? (
            <div className="mt-1 space-y-0.5">
              {m.sampleLines.map((l, i) => (
                <div key={i} className="truncate text-micro text-text-dim">
                  {l}
                </div>
              ))}
            </div>
          ) : null}
        </li>
      ))}
    </ul>
  );
}
