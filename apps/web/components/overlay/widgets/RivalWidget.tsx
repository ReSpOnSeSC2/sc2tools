"use client";

import type { LiveGamePayload } from "../types";
import { Dim, WidgetFooter, WidgetHeader, WidgetShell } from "../WidgetShell";

export function RivalWidget({ live }: { live: LiveGamePayload | null }) {
  if (!live?.rival) return null;
  const r = live.rival;
  const wins = r.headToHead?.wins ?? 0;
  const losses = r.headToHead?.losses ?? 0;
  return (
    <WidgetShell slot="top-center-3" accent="magenta" visible>
      <WidgetHeader>
        <span>Rival</span>
        <Dim>{r.name || "—"}</Dim>
      </WidgetHeader>
      <WidgetFooter>
        <span>
          {wins}-{losses} <Dim>all-time</Dim>
        </span>
        {r.note && <Dim>{r.note}</Dim>}
      </WidgetFooter>
    </WidgetShell>
  );
}
