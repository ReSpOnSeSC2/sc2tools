"use client";

import type { LiveGamePayload } from "../types";
import { Dim, WidgetHeader, WidgetShell } from "../WidgetShell";

export function TopBuildsWidget({ live }: { live: LiveGamePayload | null }) {
  const builds = live?.topBuilds || [];
  if (builds.length === 0) return null;
  return (
    <WidgetShell slot="bottom-right" accent="gold" visible width={380}>
      <WidgetHeader>
        <span style={{ fontSize: 15 }}>Your top builds</span>
        <Dim>vs {live?.oppRace || "?"}</Dim>
      </WidgetHeader>
      <ul style={{ fontSize: 13, listStyle: "none", padding: 0, marginTop: 6 }}>
        {builds.slice(0, 3).map((b) => (
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
              {Math.round(b.winRate * 100)}% / {b.total}
            </span>
          </li>
        ))}
      </ul>
    </WidgetShell>
  );
}
