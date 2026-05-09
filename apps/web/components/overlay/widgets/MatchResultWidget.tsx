"use client";

import type { LiveGamePayload } from "../types";
import { WidgetShell } from "../WidgetShell";

/**
 * Match-result chip — minimal "VICTORY" / "DEFEAT" banner with the
 * map name underneath. Streamer feedback was that the previous
 * version (matchup label, race icons, duration) competed too much
 * with the dossier widgets that fire alongside it; the result chip
 * should be a punchy stand-alone banner.
 */
export function MatchResultWidget({
  live,
}: {
  live: LiveGamePayload | null;
}) {
  if (!live || !live.result) return null;
  const win = live.result === "win";
  return (
    <WidgetShell
      slot="top-center"
      accent={win ? "green" : "red"}
      halo
      visible
      width={420}
    >
      <div
        style={{
          display: "flex",
          flexDirection: "column",
          alignItems: "center",
          gap: 6,
          padding: "4px 0",
        }}
      >
        <span
          style={{
            fontSize: 36,
            fontWeight: 800,
            letterSpacing: 2,
            color: win ? "#3ec07a" : "#ff6b6b",
            textShadow: win
              ? "0 0 18px rgba(62,192,122,0.55)"
              : "0 0 18px rgba(255,107,107,0.55)",
          }}
        >
          {win ? "VICTORY" : "DEFEAT"}
        </span>
        {live.map ? (
          <span
            style={{
              fontSize: 14,
              opacity: 0.75,
              letterSpacing: "0.02em",
              maxWidth: "100%",
              overflow: "hidden",
              textOverflow: "ellipsis",
              whiteSpace: "nowrap",
            }}
          >
            {live.map}
          </span>
        ) : null}
      </div>
    </WidgetShell>
  );
}
