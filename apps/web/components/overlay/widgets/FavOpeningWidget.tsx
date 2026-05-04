"use client";

import type { LiveGamePayload } from "../types";
import { Dim, WidgetFooter, WidgetHeader, WidgetShell } from "../WidgetShell";

export function FavOpeningWidget({ live }: { live: LiveGamePayload | null }) {
  const f = live?.favOpening;
  if (!f) return null;
  return (
    <WidgetShell slot="bottom-left" accent="cyan" visible width={300}>
      <WidgetHeader>
        <span>Their favorite opener</span>
        <Dim>{Math.round(f.share * 100)}%</Dim>
      </WidgetHeader>
      <WidgetFooter>
        <span>{f.name}</span>
        <Dim>{f.samples} samples</Dim>
      </WidgetFooter>
    </WidgetShell>
  );
}
