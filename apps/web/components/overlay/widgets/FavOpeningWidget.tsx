"use client";

import type { LiveGamePayload } from "../types";
import { Dim, WidgetFooter, WidgetHeader, WidgetShell } from "../WidgetShell";

export function FavOpeningWidget({ live }: { live: LiveGamePayload | null }) {
  const f = live?.favOpening;
  if (!f) return null;
  return (
    <WidgetShell slot="bottom-left" race={live?.oppRace} visible width={360}>
      <WidgetHeader>
        <span style={{ fontSize: 15 }}>Their favorite opener</span>
        <Dim>
          <span style={{ fontVariantNumeric: "tabular-nums" }}>
            {Math.round(f.share * 100)}%
          </span>
        </Dim>
      </WidgetHeader>
      <WidgetFooter>
        <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
          {f.name}
        </span>
        <Dim>
          <span style={{ fontVariantNumeric: "tabular-nums" }}>{f.samples} samples</span>
        </Dim>
      </WidgetFooter>
    </WidgetShell>
  );
}
