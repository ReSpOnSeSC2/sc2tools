"use client";

import type { LiveGamePayload } from "../types";
import { Dim, WidgetHeader, WidgetShell } from "../WidgetShell";

export function ScoutingWidget({ live }: { live: LiveGamePayload | null }) {
  const tells = live?.scouting || [];
  if (tells.length === 0) return null;
  return (
    <WidgetShell slot="bottom-center" accent="cyan" visible width={360}>
      <WidgetHeader>
        <span>Scouting tells</span>
        <Dim>watch for</Dim>
      </WidgetHeader>
      <ul style={{ fontSize: 12, listStyle: "none", marginTop: 4 }}>
        {tells.slice(0, 3).map((t) => (
          <li key={t.label} style={{ display: "flex", justifyContent: "space-between" }}>
            <span>{t.label}</span>
            <span style={{ opacity: 0.7 }}>
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
