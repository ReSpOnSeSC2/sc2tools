"use client";

import type { LiveGamePayload } from "../types";
import { Dim, WidgetFooter, WidgetHeader, WidgetShell } from "../WidgetShell";

export function PostGameWidget({ live }: { live: LiveGamePayload | null }) {
  if (!live || !live.result) return null;
  const builds = (live.topBuilds || []).slice(0, 3);
  return (
    <WidgetShell slot="top-center-1" accent="gold" visible>
      <WidgetHeader>
        <span style={{ fontSize: 13 }}>Build summary</span>
        <Dim>this game</Dim>
      </WidgetHeader>
      <ul style={{ marginTop: 4, fontSize: 12, listStyle: "none" }}>
        {builds.length === 0 ? (
          <li style={{ opacity: 0.55 }}>No build classified</li>
        ) : (
          builds.map((b) => (
            <li key={b.name} style={{ display: "flex", justifyContent: "space-between" }}>
              <span>{b.name}</span>
              <span style={{ opacity: 0.7 }}>
                {Math.round(b.winRate * 100)}% over {b.total}
              </span>
            </li>
          ))
        )}
      </ul>
      <WidgetFooter>
        <Dim>vs {live.oppRace || "?"}</Dim>
        <Dim>{live.map || ""}</Dim>
      </WidgetFooter>
    </WidgetShell>
  );
}
