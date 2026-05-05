"use client";

import type { LiveGamePayload } from "../types";
import { Dim, WidgetFooter, WidgetHeader, WidgetShell } from "../WidgetShell";

export function BestAnswerWidget({ live }: { live: LiveGamePayload | null }) {
  const a = live?.bestAnswer;
  if (!a) return null;
  return (
    <WidgetShell slot="bottom-right" accent="green" visible width={360}>
      <WidgetHeader>
        <span style={{ fontSize: 15 }}>Best answer</span>
        <Dim>
          <span style={{ fontVariantNumeric: "tabular-nums" }}>
            {Math.round(a.winRate * 100)}% over {a.total}
          </span>
        </Dim>
      </WidgetHeader>
      <WidgetFooter>
        <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
          {a.build}
        </span>
      </WidgetFooter>
    </WidgetShell>
  );
}
