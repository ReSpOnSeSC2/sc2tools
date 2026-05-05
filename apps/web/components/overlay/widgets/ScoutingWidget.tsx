"use client";

import type { LiveGamePayload } from "../types";
import { Dim, WidgetHeader, WidgetShell } from "../WidgetShell";

export function ScoutingWidget({ live }: { live: LiveGamePayload | null }) {
  const tells = live?.scouting || [];
  if (tells.length === 0) return null;
  return (
    <WidgetShell slot="bottom-center" accent="cyan" halo visible width={520}>
      <WidgetHeader>
        <span style={{ fontSize: 16 }}>Scouting tells</span>
        <Dim>watch for</Dim>
      </WidgetHeader>
      <ul style={{ fontSize: 14, listStyle: "none", padding: 0, marginTop: 8 }}>
        {tells.slice(0, 3).map((t) => (
          <li
            key={t.label}
            style={{
              display: "flex",
              justifyContent: "space-between",
              gap: 12,
              padding: "3px 0",
            }}
          >
            <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
              {t.label}
            </span>
            <span
              style={{
                opacity: 0.7,
                fontVariantNumeric: "tabular-nums",
                flexShrink: 0,
              }}
            >
              {t.tellAt
                ? `${Math.floor(t.tellAt / 60)}:${String(Math.round(t.tellAt % 60)).padStart(2, "0")}`
                : ""}
            </span>
          </li>
        ))}
      </ul>
    </WidgetShell>
  );
}
