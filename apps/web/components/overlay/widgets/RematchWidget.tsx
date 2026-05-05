"use client";

import type { LiveGamePayload } from "../types";
import { Dim, WidgetHeader, WidgetShell } from "../WidgetShell";

export function RematchWidget({ live }: { live: LiveGamePayload | null }) {
  if (!live?.rematch?.isRematch) return null;
  const last = live.rematch.lastResult;
  return (
    <WidgetShell slot="top-center-2" accent="cyan" visible width={320}>
      <WidgetHeader>
        <span style={{ fontSize: 15 }}>Rematch</span>
        <Dim>last game</Dim>
      </WidgetHeader>
      <div style={{ marginTop: 6 }}>
        <Dim>
          {last
            ? `You ${last === "win" ? "won" : "lost"} the previous match against ${live.oppName || "this opponent"}.`
            : "Same opponent as the previous game."}
        </Dim>
      </div>
    </WidgetShell>
  );
}
