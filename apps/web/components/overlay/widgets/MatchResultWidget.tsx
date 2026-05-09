"use client";

import type { LiveGamePayload } from "../types";
import { Dim, RaceIcon, WidgetFooter, WidgetHeader, WidgetShell } from "../WidgetShell";

/**
 * Match-result chip — VICTORY/DEFEAT banner with the matchup label
 * and race icons inline at left, plus the map and duration in the
 * footer for viewer context.
 *
 * Originally trimmed to just the result + map name in PR #171; the
 * streamer asked for the matchup label / race icons / duration back
 * because they make the chip read like a stand-alone match summary
 * even when other post-game widgets aren't in the OBS scene.
 */
export function MatchResultWidget({ live }: { live: LiveGamePayload | null }) {
  if (!live || !live.result) return null;
  const win = live.result === "win";
  return (
    <WidgetShell
      slot="top-center"
      accent={win ? "green" : "red"}
      halo
      visible
      width={480}
    >
      <WidgetHeader>
        <span
          style={{
            display: "inline-flex",
            gap: 10,
            alignItems: "center",
          }}
        >
          <RaceIcon race={live.myRace} size={24} />
          <span
            style={{
              fontSize: 14,
              opacity: 0.7,
              fontVariantNumeric: "tabular-nums",
            }}
          >
            {live.matchup || `${live.myRace || "?"}v${live.oppRace || "?"}`}
          </span>
          <RaceIcon race={live.oppRace} size={24} />
        </span>
        <span
          style={{
            fontSize: 22,
            fontWeight: 800,
            letterSpacing: 1.5,
            color: win ? "#3ec07a" : "#ff6b6b",
            textShadow: win
              ? "0 0 14px rgba(62,192,122,0.45)"
              : "0 0 14px rgba(255,107,107,0.45)",
          }}
        >
          {win ? "VICTORY" : "DEFEAT"}
        </span>
      </WidgetHeader>
      <WidgetFooter>
        <span>{live.map || "—"}</span>
        <Dim>{fmtDur(live.durationSec)}</Dim>
      </WidgetFooter>
    </WidgetShell>
  );
}

function fmtDur(s?: number): string {
  if (!s) return "";
  const m = Math.floor(s / 60);
  const r = Math.round(s % 60);
  return `${m}:${r.toString().padStart(2, "0")}`;
}
