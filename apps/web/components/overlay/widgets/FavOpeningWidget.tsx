"use client";

import type { LiveGamePayload } from "../types";
import { ofLastGames } from "../scoutingCopy";
import { Dim, WidgetFooter, WidgetHeader, WidgetShell } from "../WidgetShell";

export function FavOpeningWidget({ live }: { live: LiveGamePayload | null }) {
  const f = live?.favOpening;
  if (!f) return null;
  // Payloads cached before ``of`` existed still read "N samples".
  const sample = typeof f.of === "number" && f.of > 0
    ? ofLastGames(f.samples, f.of)
    : `${f.samples} samples`;
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
        <span style={{ minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
          {f.name}
        </span>
        <Dim>
          <span style={{ fontVariantNumeric: "tabular-nums", whiteSpace: "nowrap" }}>{sample}</span>
        </Dim>
      </WidgetFooter>
    </WidgetShell>
  );
}
