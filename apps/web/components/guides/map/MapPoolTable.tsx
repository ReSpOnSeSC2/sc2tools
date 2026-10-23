"use client";

import { useId, useState } from "react";
import Link from "next/link";
import { Input } from "@/components/ui/Input";
import { Select } from "@/components/ui/Select";
import { SortableTh } from "@/components/ui/SortableTh";
import { WinRateCell } from "../WinRateCell";
import { guidePaths } from "../guideMetadata";
import { normalizeGuideSearch, useGuideTableControls, type GuideTableSort } from "../useGuideTableControls";
import { GUIDE_LINK_CLASS, GUIDE_TABLE_WRAP_CLASS, GUIDE_TD_CLASS, GUIDE_TD_NUM_CLASS, GUIDE_THEAD_CLASS } from "../guideUi";
import type { GuideIndexMap, GuideMatchup } from "@/lib/guides/types";

const MATCHUPS: GuideMatchup[] = ["PvT", "PvZ", "TvP", "TvZ", "ZvP", "ZvT"];
const SORTS: Readonly<Record<string, GuideTableSort<GuideIndexMap>>> = Object.fromEntries([
  ["name", { label: "Map", pick: (row: GuideIndexMap) => normalizeGuideSearch(row.map) }],
  ...MATCHUPS.map((matchup) => [matchup, { label: matchup, pick: (row: GuideIndexMap) => row.cells?.find((cell) => cell.matchup === matchup)?.winRate }]),
]);

export function MapPoolTable({ maps }: { maps: ReadonlyArray<GuideIndexMap> }) {
  const [race, setRace] = useState(""); const [scrolled, setScrolled] = useState(false); const id = useId();
  const controls = useGuideTableControls(maps, { sorts: SORTS, defaultSort: null, filterFn: (row, query) => normalizeGuideSearch(row.map).includes(query) });
  const columns = MATCHUPS.filter((matchup) => !race || matchup.startsWith(race));
  return <div className="min-w-0 space-y-3">
    <div className="flex flex-wrap items-end gap-3">
      <label className="min-w-0 flex-1 text-caption font-semibold text-text">Find a map<Input type="search" maxLength={100} aria-controls={id} value={controls.query} onChange={(event) => controls.setQuery(event.target.value)} /></label>
      <label className="text-caption font-semibold text-text">I play<Select value={race} onChange={(event) => setRace(event.target.value)}><option value="">All</option><option value="P">Protoss</option><option value="T">Terran</option><option value="Z">Zerg</option></Select></label>
      <p aria-live="polite" className="text-caption text-text-muted">{controls.count} of {maps.length} maps</p>
    </div>
    {!race ? <p className="text-caption text-text-muted sm:hidden">Pick your race to fit the table</p> : null}
    <div className={`${GUIDE_TABLE_WRAP_CLASS} ${scrolled ? "[&_th:first-child]:shadow-[3px_0_4px_rgb(0_0_0_/_0.2)]" : ""}`} onScroll={(event) => setScrolled(event.currentTarget.scrollLeft > 0)}>
      <table id={id} className={`w-full text-caption [&_th:first-child]:sticky [&_th:first-child]:left-0 [&_th:first-child]:z-10 ${race ? "min-w-[300px]" : "min-w-[760px]"}`}><caption className="sr-only">Map pool win rates by matchup</caption>
        <thead className={`${GUIDE_THEAD_CLASS} [&_th:first-child]:bg-bg-elevated`}><tr><SortableTh col="name" label="Map" {...controls.sortProps} />{columns.map((matchup) => <SortableTh key={matchup} col={matchup} label={matchup} {...controls.sortProps} align="right" />)}</tr></thead>
        <tbody className="divide-y divide-border">{controls.visibleRows.map((map) => <tr key={map.slug}><th scope="row" className={`${GUIDE_TD_CLASS} w-36 max-w-36 break-words bg-bg-surface text-left font-medium`}><Link href={guidePaths.map(map.slug)} className={GUIDE_LINK_CLASS}>{map.map}</Link></th>{columns.map((matchup) => {
          const cell = map.cells?.find((entry) => entry.matchup === matchup);
          return <td key={matchup} className={GUIDE_TD_NUM_CLASS}>{cell ? <WinRateCell winRate={cell.winRate} ci={cell.ci} compact showWhisker={false} /> : "—"}</td>;
        })}</tr>)}</tbody>
      </table>
    </div>
    {!controls.count ? <p role="status" className="text-caption text-text-muted">No map matches “{controls.query}”</p> : null}
  </div>;
}
