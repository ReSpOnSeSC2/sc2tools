"use client";

import { useLayoutEffect, useMemo, useRef, useState } from "react";
import { Card } from "@/components/ui/Card";
import { pct1 } from "@/lib/format";
import { matrixAxes, matrixCellKey, matrixCellStyle } from "@/lib/strategyMatrix";
import type { BvsCell } from "./StrategiesTabBuildVs";

export function StrategyMatrixHeatmap({ rows, order, minGames, onOpenBvs }: {
  rows: BvsCell[]; order: "games" | "az"; minGames: number;
  onOpenBvs: (build: string, strategy: string) => void;
}) {
  const host = useRef<HTMLDivElement>(null);
  const [surface, setSurface] = useState<readonly [number, number, number]>([12, 16, 23]);
  useLayoutEffect(() => {
    const read = () => {
      if (!host.current) return;
      const values = getComputedStyle(host.current).getPropertyValue("--bg-surface").match(/[\d.]+/g)?.map(Number);
      if (values && values.length >= 3) setSurface([values[0], values[1], values[2]]);
    };
    read();
    const observer = new MutationObserver(read);
    for (const element of [document.documentElement, document.body]) observer.observe(element, { attributes: true, attributeFilter: ["data-theme", "class", "style"] });
    return () => observer.disconnect();
  }, []);
  const { builds, strategies } = useMemo(() => matrixAxes(rows, order), [rows, order]);
  const lookup = useMemo(() => new Map(rows.map(row => [matrixCellKey(row.my_build, row.opp_strat), row])), [rows]);
  return <Card><div ref={host} className="overflow-auto">
    <table className="border-collapse text-xs" aria-label="Build versus strategy heatmap">
      <thead><tr><th scope="col" className="sticky left-0 z-10 bg-bg-surface px-2 py-2 text-left text-text-muted">My build ↓ / vs →</th>{strategies.map(strategy => <th scope="col" key={strategy} className="min-w-24 max-w-40 px-2 py-2 align-bottom text-text-muted"><div className="break-words">{strategy}</div></th>)}</tr></thead>
      <tbody>{builds.map(build => <tr key={build}><th scope="row" className="sticky left-0 z-10 max-w-48 break-words bg-bg-surface px-2 py-2 text-left font-medium text-text">{build}</th>{strategies.map(strategy => {
        const cell = lookup.get(matrixCellKey(build, strategy));
        if (!cell) return <td key={strategy} className="p-0.5"><span className="flex min-h-11 items-center justify-center rounded bg-bg-elevated text-text-dim" aria-label="No games">—</span></td>;
        const { backgroundColor, color } = matrixCellStyle(cell.winRate, cell.total, minGames, surface);
        return <td key={strategy} className="p-0.5"><button type="button" onClick={() => onOpenBvs(build, strategy)} style={{ backgroundColor, color }} className="min-h-11 w-full rounded px-2 text-micro font-semibold tabular-nums ring-1 ring-inset ring-black/30 hover:ring-2 hover:ring-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent" aria-label={`${build} vs ${strategy}, ${cell.total} games, ${pct1(cell.winRate)} win rate. View games`} title={`${cell.wins}W · ${cell.losses}L · ${cell.total} games`}>{pct1(cell.winRate).replace(".0", "")}<span className="block font-normal">n={cell.total}</span></button></td>;
      })}</tr>)}</tbody>
    </table>
    <p className="mt-3 text-micro text-text-dim">Color shows win rate; background strength shows sample size against Min games. Labels stay opaque. Select a cell to view games.</p>
  </div></Card>;
}
