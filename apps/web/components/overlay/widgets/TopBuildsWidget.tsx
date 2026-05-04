"use client";

import type { LiveGamePayload } from "../types";
import { Dim, WidgetHeader, WidgetShell } from "../WidgetShell";

export function TopBuildsWidget({ live }: { live: LiveGamePayload | null }) {
  const builds = live?.topBuilds || [];
  if (builds.length === 0) return null;
  return (
    <WidgetShell slot="bottom-right" accent="gold" visible width={300}>
      <WidgetHeader>
        <span>Your top builds</span>
        <Dim>vs {live?.oppRace || "?"}</Dim>
      </WidgetHeader>
      <ul style={{ fontSize: 12, listStyle: "none", marginTop: 4 }}>
        {builds.slice(0, 3).map((b) => (
          <li
            key={b.name}
            style={{ display: "flex", justifyContent: "space-between" }}
          >
            <span>{b.name}</span>
            <span style={{ opacity: 0.7 }}>
              {Math.round(b.winRate * 100)}% / {b.total}
            </span>
          </li>
        ))}
      </ul>
    </WidgetShell>
  );
}
