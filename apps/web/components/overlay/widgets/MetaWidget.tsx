"use client";

import type { LiveGamePayload } from "../types";
import { Dim, WidgetHeader, WidgetShell } from "../WidgetShell";

export function MetaWidget({ live }: { live: LiveGamePayload | null }) {
  const m = live?.meta;
  if (!m || !m.topBuilds || m.topBuilds.length === 0) return null;
  return (
    <WidgetShell slot="bottom-left" accent="neutral" visible width={380}>
      <WidgetHeader>
        <span style={{ fontSize: 15 }}>Ladder meta</span>
        <Dim>{m.matchup || ""}</Dim>
      </WidgetHeader>
      <ul style={{ fontSize: 13, listStyle: "none", padding: 0, marginTop: 6 }}>
        {m.topBuilds.slice(0, 4).map((b) => (
          <li
            key={b.name}
            style={{
              display: "flex",
              justifyContent: "space-between",
              gap: 12,
              padding: "2px 0",
            }}
          >
            <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
              {b.name}
            </span>
            <span style={{ opacity: 0.7, fontVariantNumeric: "tabular-nums", flexShrink: 0 }}>
              {Math.round(b.share * 100)}%
            </span>
          </li>
        ))}
      </ul>
    </WidgetShell>
  );
}
