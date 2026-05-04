"use client";

import type { LiveGamePayload } from "../types";
import { Dim, WidgetHeader, WidgetShell } from "../WidgetShell";

export function StreakWidget({ live }: { live: LiveGamePayload | null }) {
  if (!live?.streak || live.streak.count < 3) return null;
  const win = live.streak.kind === "win";
  return (
    <WidgetShell slot="top-center-2" accent={win ? "green" : "red"} visible width={260}>
      <WidgetHeader>
        <span style={{ fontSize: 13 }}>
          {win ? "Hot streak" : "Cool down"}
        </span>
        <span
          style={{
            fontSize: 22,
            fontWeight: 800,
            color: win ? "#3ec07a" : "#ff6b6b",
          }}
        >
          {live.streak.count}
        </span>
      </WidgetHeader>
      <Dim>
        {win
          ? `${live.streak.count} wins in a row — keep it going.`
          : `${live.streak.count} losses in a row — take five.`}
      </Dim>
    </WidgetShell>
  );
}
