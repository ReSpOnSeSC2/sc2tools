"use client";

import type { LiveGamePayload } from "../types";
import { Dim, WidgetHeader, WidgetShell } from "../WidgetShell";

export function MetaWidget({ live }: { live: LiveGamePayload | null }) {
  const m = live?.meta;
  if (!m || !m.topBuilds || m.topBuilds.length === 0) return null;
  return (
    <WidgetShell slot="bottom-left" accent="neutral" visible width={300}>
      <WidgetHeader>
        <span>Ladder meta</span>
        <Dim>{m.matchup || ""}</Dim>
      </WidgetHeader>
      <ul style={{ fontSize: 12, listStyle: "none", marginTop: 4 }}>
        {m.topBuilds.slice(0, 4).map((b) => (
          <li
            key={b.name}
            style={{ display: "flex", justifyContent: "space-between" }}
          >
            <span>{b.name}</span>
            <span style={{ opacity: 0.7 }}>
              {Math.round(b.share * 100)}%
            </span>
          </li>
        ))}
      </ul>
    </WidgetShell>
  );
}
