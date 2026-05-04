"use client";

import type { LiveGamePayload } from "../types";
import { Dim, WidgetFooter, WidgetHeader, WidgetShell } from "../WidgetShell";

export function RankWidget({ live }: { live: LiveGamePayload | null }) {
  if (!live?.rank) return null;
  const r = live.rank;
  return (
    <WidgetShell slot="top-right" accent="gold" visible width={220}>
      <WidgetHeader>
        <span>{r.league || "Unranked"}</span>
        {typeof r.tier === "number" && (
          <Dim>Tier {r.tier}</Dim>
        )}
      </WidgetHeader>
      <WidgetFooter>
        <Dim>MMR</Dim>
        <span>{r.mmr ?? "—"}</span>
      </WidgetFooter>
    </WidgetShell>
  );
}
