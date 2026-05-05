"use client";

import type { LiveGamePayload } from "../types";
import { Dim, WidgetFooter, WidgetHeader, WidgetShell } from "../WidgetShell";

export function CheeseWidget({ live }: { live: LiveGamePayload | null }) {
  if (!live || typeof live.cheeseProbability !== "number") return null;
  if (live.cheeseProbability < 0.4) return null;
  const pct = Math.round(live.cheeseProbability * 100);
  return (
    <WidgetShell slot="top-center-1" accent="magenta" halo visible width={340}>
      <WidgetHeader>
        <span>Cheese alert</span>
        <span
          style={{
            fontSize: 22,
            fontWeight: 800,
            color: "#d16ba5",
            fontVariantNumeric: "tabular-nums",
            textShadow: "0 0 12px rgba(209,107,165,0.45)",
          }}
        >
          {pct}%
        </span>
      </WidgetHeader>
      <WidgetFooter>
        <Dim>scout the natural early</Dim>
      </WidgetFooter>
    </WidgetShell>
  );
}
