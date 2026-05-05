"use client";

import type { LiveGamePayload } from "../types";
import { Dim, RaceIcon, WidgetFooter, WidgetHeader, WidgetShell } from "../WidgetShell";

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
        <span style={{ display: "inline-flex", gap: 10, alignItems: "center" }}>
          <RaceIcon race={live.myRace} size={24} />
          <span style={{ fontSize: 14, opacity: 0.7, fontVariantNumeric: "tabular-nums" }}>
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
