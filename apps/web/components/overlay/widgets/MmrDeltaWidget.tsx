"use client";

import type { LiveGamePayload } from "../types";
import { Dim, WidgetFooter, WidgetHeader, WidgetShell } from "../WidgetShell";

export function MmrDeltaWidget({ live }: { live: LiveGamePayload | null }) {
  if (!live || typeof live.mmrDelta !== "number") return null;
  const positive = live.mmrDelta >= 0;
  return (
    <WidgetShell slot="top-right-mmr" accent="gold" visible width={240}>
      <WidgetHeader>
        <Dim>MMR</Dim>
        <span
          style={{
            fontSize: 22,
            fontWeight: 800,
            color: positive ? "#3ec07a" : "#ff6b6b",
            tabSize: "tabular-nums" as any,
          }}
        >
          {positive ? "+" : ""}
          {live.mmrDelta}
        </span>
      </WidgetHeader>
      {typeof live.myMmr === "number" && (
        <WidgetFooter>
          <Dim>now</Dim>
          <span>{live.myMmr}</span>
        </WidgetFooter>
      )}
    </WidgetShell>
  );
}
