"use client";

import type { LiveGamePayload } from "../types";
import { Dim, WidgetHeader, WidgetShell } from "../WidgetShell";

export function SessionWidget({ live }: { live: LiveGamePayload | null }) {
  const s = live?.session;
  if (!s) return null;
  const delta =
    typeof s.mmrCurrent === "number" && typeof s.mmrStart === "number"
      ? s.mmrCurrent - s.mmrStart
      : null;
  const deltaColor =
    delta == null ? "inherit" : delta >= 0 ? "#3ec07a" : "#ff6b6b";
  return (
    <WidgetShell slot="top-right" accent="neutral" visible width={220}>
      <WidgetHeader>
        <span style={{ fontSize: 13 }}>Today</span>
        <span>
          {s.wins}W &ndash; {s.losses}L
        </span>
      </WidgetHeader>
      {delta != null && (
        <div style={{ marginTop: 4, display: "flex", justifyContent: "space-between", fontSize: 12 }}>
          <Dim>MMR delta</Dim>
          <span style={{ color: deltaColor, fontWeight: 700 }}>
            {delta >= 0 ? "+" : ""}
            {delta}
          </span>
        </div>
      )}
    </WidgetShell>
  );
}
