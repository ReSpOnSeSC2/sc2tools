"use client";

import type { LiveGamePayload } from "../types";
import { Dim, RaceIcon, WidgetFooter, WidgetHeader, WidgetShell } from "../WidgetShell";

export function MatchResultWidget({ live }: { live: LiveGamePayload | null }) {
  if (!live || !live.result) return null;
  const win = live.result === "win";
  return (
    <WidgetShell slot="top-center" accent={win ? "green" : "red"} visible>
      <WidgetHeader>
        <span style={{ display: "inline-flex", gap: 8, alignItems: "center" }}>
          <RaceIcon race={live.myRace} />
          <span style={{ fontSize: 13, opacity: 0.7 }}>
            {live.matchup || `${live.myRace || "?"}v${live.oppRace || "?"}`}
          </span>
          <RaceIcon race={live.oppRace} />
        </span>
        <span
          style={{
            fontSize: 18,
            fontWeight: 800,
            letterSpacing: 1,
            color: win ? "#3ec07a" : "#ff6b6b",
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
