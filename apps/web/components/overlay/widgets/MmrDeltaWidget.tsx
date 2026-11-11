"use client";

import type { LiveGamePayload } from "../types";
import { Dim, WidgetFooter, WidgetHeader, WidgetShell } from "../WidgetShell";

export function MmrDeltaWidget({ live }: { live: LiveGamePayload | null }) {
  if (!live || typeof live.mmrChangeBetweenStarts !== "number") return null;
  const positive = live.mmrChangeBetweenStarts >= 0;
  return (
    <WidgetShell
      slot="top-right-mmr"
      accent={positive ? "green" : "red"}
      halo
      visible
      width={300}
    >
      <WidgetHeader>
        <Dim>MMR between game starts</Dim>
        <span
          style={{
            fontSize: 28,
            fontWeight: 800,
            color: positive ? "#3ec07a" : "#ff6b6b",
            fontVariantNumeric: "tabular-nums",
            textShadow: positive
              ? "0 0 12px rgba(62,192,122,0.4)"
              : "0 0 12px rgba(255,107,107,0.4)",
          }}
        >
          {positive ? "+" : ""}
          {live.mmrChangeBetweenStarts}
        </span>
      </WidgetHeader>
      {typeof live.myMmr === "number" && (
        <WidgetFooter>
          <Dim>Latest starting MMR</Dim>
          <span style={{ fontVariantNumeric: "tabular-nums" }}>{live.myMmr}</span>
        </WidgetFooter>
      )}
    </WidgetShell>
  );
}
