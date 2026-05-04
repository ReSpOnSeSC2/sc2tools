"use client";

import type { LiveGamePayload } from "../types";
import {
  Dim,
  RaceIcon,
  WidgetFooter,
  WidgetHeader,
  WidgetShell,
} from "../WidgetShell";

export function OpponentWidget({ live }: { live: LiveGamePayload | null }) {
  if (!live) return null;
  const wins = live.headToHead?.wins ?? 0;
  const losses = live.headToHead?.losses ?? 0;
  return (
    <WidgetShell slot="top-center" accent="cyan" visible>
      <WidgetHeader>
        <span style={{ display: "inline-flex", gap: 8, alignItems: "center" }}>
          <RaceIcon race={live.oppRace} />
          <span>{live.oppName || "Opponent"}</span>
        </span>
        <span style={{ fontSize: 14, opacity: 0.85 }}>
          {typeof live.oppMmr === "number" ? `${live.oppMmr} MMR` : ""}
        </span>
      </WidgetHeader>
      <WidgetFooter>
        <Dim>{live.matchup || `${live.myRace || "?"}v${live.oppRace || "?"}`}</Dim>
        <span>
          {wins}-{losses} <Dim>head-to-head</Dim>
        </span>
      </WidgetFooter>
    </WidgetShell>
  );
}
