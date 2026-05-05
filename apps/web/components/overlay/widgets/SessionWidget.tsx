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
    <WidgetShell slot="top-right" accent="neutral" visible width={480}>
      <WidgetHeader>
        <span style={{ fontSize: 15 }}>Today</span>
        <span style={{ fontSize: 18, fontWeight: 700, fontVariantNumeric: "tabular-nums" }}>
          {s.wins}W &ndash; {s.losses}L
        </span>
      </WidgetHeader>
      {delta != null && (
        <div
          style={{
            marginTop: 8,
            display: "flex",
            justifyContent: "space-between",
            fontSize: 13,
            alignItems: "baseline",
          }}
        >
          <Dim>MMR delta</Dim>
          <span
            style={{
              color: deltaColor,
              fontWeight: 700,
              fontSize: 16,
              fontVariantNumeric: "tabular-nums",
            }}
          >
            {delta >= 0 ? "+" : ""}
            {delta}
          </span>
        </div>
      )}
    </WidgetShell>
  );
}
