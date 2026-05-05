"use client";

import type { LiveGamePayload } from "../types";
import { Dim, WidgetHeader, WidgetShell } from "../WidgetShell";

export function StreakWidget({ live }: { live: LiveGamePayload | null }) {
  if (!live?.streak || live.streak.count < 3) return null;
  const win = live.streak.kind === "win";
  return (
    <WidgetShell
      slot="top-center-2"
      accent={win ? "green" : "red"}
      halo={win}
      visible
      width={320}
    >
      <WidgetHeader>
        <span style={{ fontSize: 15 }}>
          {win ? "Hot streak" : "Cool down"}
        </span>
        <span
          style={{
            fontSize: 28,
            fontWeight: 800,
            color: win ? "#3ec07a" : "#ff6b6b",
            fontVariantNumeric: "tabular-nums",
            textShadow: win ? "0 0 14px rgba(62,192,122,0.4)" : undefined,
          }}
        >
          {live.streak.count}
        </span>
      </WidgetHeader>
      <div style={{ marginTop: 6 }}>
        <Dim>
          {win
            ? `${live.streak.count} wins in a row — keep it going.`
            : `${live.streak.count} losses in a row — take five.`}
        </Dim>
      </div>
    </WidgetShell>
  );
}
