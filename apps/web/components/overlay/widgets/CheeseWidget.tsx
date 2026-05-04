"use client";

import type { LiveGamePayload } from "../types";
import { Dim, WidgetFooter, WidgetHeader, WidgetShell } from "../WidgetShell";

export function CheeseWidget({ live }: { live: LiveGamePayload | null }) {
  if (!live || typeof live.cheeseProbability !== "number") return null;
  if (live.cheeseProbability < 0.4) return null;
  const pct = Math.round(live.cheeseProbability * 100);
  return (
    <WidgetShell slot="top-center-1" accent="magenta" visible width={300}>
      <WidgetHeader>
        <span>Cheese alert</span>
        <span style={{ fontSize: 18, fontWeight: 800, color: "#d16ba5" }}>
          {pct}%
        </span>
      </WidgetHeader>
      <WidgetFooter>
        <Dim>scout the natural early</Dim>
      </WidgetFooter>
    </WidgetShell>
  );
}
