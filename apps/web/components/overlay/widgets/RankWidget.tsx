"use client";

import type { LiveGamePayload } from "../types";
import { Icon } from "@/components/ui/Icon";
import { Dim, WidgetFooter, WidgetHeader, WidgetShell } from "../WidgetShell";

export function RankWidget({ live }: { live: LiveGamePayload | null }) {
  if (!live?.rank) return null;
  const r = live.rank;
  const league = r.league || "Unranked";
  return (
    <WidgetShell slot="top-right" accent="gold" visible width={280}>
      <WidgetHeader>
        <span style={{ display: "inline-flex", gap: 10, alignItems: "center" }}>
          <Icon name={league} kind="league" size={26} decorative fallback={league.slice(0, 2)} />
          <span style={{ fontSize: 16 }}>{league}</span>
        </span>
        {typeof r.tier === "number" && <Dim>Tier {r.tier}</Dim>}
      </WidgetHeader>
      <WidgetFooter>
        <Dim>MMR</Dim>
        <span style={{ fontVariantNumeric: "tabular-nums" }}>{r.mmr ?? "—"}</span>
      </WidgetFooter>
    </WidgetShell>
  );
}
