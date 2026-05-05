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
    <WidgetShell slot="top-center" race={live.oppRace} halo visible width={480}>
      <WidgetHeader>
        <span style={{ display: "inline-flex", gap: 10, alignItems: "center", minWidth: 0 }}>
          <RaceIcon race={live.oppRace} size={26} />
          <span style={{ fontSize: 20, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
            {live.oppName || "Opponent"}
          </span>
        </span>
        <span style={{ fontSize: 16, opacity: 0.85, fontVariantNumeric: "tabular-nums" }}>
          {typeof live.oppMmr === "number" ? `${live.oppMmr} MMR` : ""}
        </span>
      </WidgetHeader>
      <WidgetFooter>
        <Dim>{live.matchup || `${live.myRace || "?"}v${live.oppRace || "?"}`}</Dim>
        <span style={{ fontVariantNumeric: "tabular-nums" }}>
          {wins}-{losses} <Dim>head-to-head</Dim>
        </span>
      </WidgetFooter>
    </WidgetShell>
  );
}
