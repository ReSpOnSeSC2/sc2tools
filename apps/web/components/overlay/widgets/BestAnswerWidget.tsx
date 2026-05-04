"use client";

import type { LiveGamePayload } from "../types";
import { Dim, WidgetFooter, WidgetHeader, WidgetShell } from "../WidgetShell";

export function BestAnswerWidget({ live }: { live: LiveGamePayload | null }) {
  const a = live?.bestAnswer;
  if (!a) return null;
  return (
    <WidgetShell slot="bottom-right" accent="green" visible width={300}>
      <WidgetHeader>
        <span>Best answer</span>
        <Dim>{Math.round(a.winRate * 100)}% over {a.total}</Dim>
      </WidgetHeader>
      <WidgetFooter>
        <span>{a.build}</span>
      </WidgetFooter>
    </WidgetShell>
  );
}
