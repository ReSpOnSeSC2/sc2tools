"use client";

import Link from "next/link";
import { useMemo, useState } from "react";
import { Card } from "@/components/ui/Card";
import type { CasualtySide, MacroBreakdownData } from "@/components/analyzer/macro/MacroBreakdownPanel.types";
import { formatGameClock } from "@/lib/macro";
import { unitTrades } from "@/lib/unitTrades";
import type { GameBuildOrderResponse } from "./types";

type Props = { data?: MacroBreakdownData | null; orders?: GameBuildOrderResponse | null; era?: Parameters<typeof unitTrades>[3]; loading?: boolean };
const fixed = (value: number) => new Intl.NumberFormat(undefined, { maximumFractionDigits: 1 }).format(value);

export function UnitTradesCard({ data, orders, era, loading }: Props) {
  const [side, setSide] = useState<CasualtySide>("me");
  const deaths = data?.casualty_events;
  const detailed = deaths?.some(death => death.bornAt !== undefined || !!death.killerUnit) ?? false;
  const ordersForSide = side === "me" ? orders?.events : orders?.opp_events;
  const fullCounts = side === "me" && orders?.recorded_units_built && Object.keys(orders.recorded_units_built).length
    ? orders.recorded_units_built : undefined;
  const rows = useMemo(() => detailed ? unitTrades(deaths ?? [], ordersForSide ?? [], side, era, fullCounts) : [],
    [deaths, detailed, ordersForSide, side, era, fullCounts]);
  const candidates = rows.filter(row => row.ratio !== null && row.name !== "Unattributed").sort((a, b) => b.ratio! - a.ratio!);
  const best = candidates[0], worst = candidates.length > 1 ? candidates.at(-1) : undefined;
  if (loading) return null;
  return <Card title="Units">
    <div role="group" aria-label="Unit trades side" className="mb-2 flex gap-2">
      {(["me", "opp"] as const).map(value => <button key={value} type="button" aria-pressed={value === side} onClick={() => setSide(value)}
        className="min-h-11 rounded-md border border-border px-3 text-caption aria-pressed:border-accent">{value === "me" ? "You" : "Opponent"}</button>)}
    </div>
    {!detailed ? <div className="space-y-2 text-caption text-text-muted">
      {deaths ? <p>{deaths.filter(row => row.category !== "buildings" && row.owner === side).length} unit losses · {deaths.filter(row => row.category !== "buildings" && row.owner !== side && row.killer === side).length} credited unit kills</p> : null}
      <Link href="/settings?tab=backups" className="text-accent underline">Update the app and re-analyze for unit detail</Link>
    </div> : <>
      <p className="mb-2 text-micro text-text-muted">Built counts come from recorded build steps and can omit starting workers. Resource totals use known mineral and gas costs. Expand a unit to see its recorded matchups.</p>
      <div tabIndex={0} role="region" aria-label="Scrollable unit trade table" className="max-h-96 overflow-auto">
        <table className="min-w-[36rem] text-left text-micro tabular-nums">
          <thead><tr>{["Unit", "Built", "Lost", "Kills", "Resources killed", "Resources lost", "Trade ratio", "Median lifespan"].map(label => <th key={label} scope="col" className="p-2">{label}</th>)}</tr></thead>
          <tbody>{rows.map(row => <tr key={row.name} className="border-t border-border">
            <th scope="row" className="sticky left-0 bg-bg-surface p-2 align-top">
              <details><summary className="min-h-8 cursor-pointer font-semibold">{row.name}{row === best ? " · Best trade" : row === worst ? " · Lowest trade" : ""}</summary>
                <p className="max-w-40 font-normal">Killed {formatCounts(row.killed)}</p>
                <p className="max-w-40 font-normal">Died to {formatCounts(row.diedTo, row.lost)}</p>
              </details>
            </th>
            <td className="p-2">{ordersForSide && row.name !== "Unattributed" ? row.recordedBuilt : "—"}</td>
            <td className="p-2">{row.lost}</td><td className="p-2">{row.kills}</td>
            <td className="p-2">{row.resourcesKilled}</td><td className="p-2">{row.resourcesLost}</td>
            <td className="p-2">{row.ratio === null ? "—" : `${fixed(row.ratio)}:1`}</td>
            <td className="p-2">{row.median === null ? "—" : formatGameClock(Math.round(row.median))}</td>
          </tr>)}</tbody>
        </table>
      </div>
    </>}
  </Card>;
}

function formatCounts(rows: Map<string, number>, total?: number) {
  return [...rows].sort((a, b) => b[1] - a[1]).map(([name, count]) =>
    total ? `${name} ${Math.round(count / total * 100)}%` : `${count} ${name}`).join(", ") || "—";
}
