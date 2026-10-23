"use client";

import { useId, useState } from "react";
import Link from "next/link";
import { SortableTh } from "@/components/ui/SortableTh";
import { Input } from "@/components/ui/Input";
import { Button } from "@/components/ui/Button";
import { TrendBadge } from "@/components/guides/TrendBadge";
import { WinRateCell } from "@/components/guides/WinRateCell";
import { normalizeGuideSearch, useGuideTableControls, type GuideTableSort } from "../useGuideTableControls";
import { guidePaths } from "../guideMetadata";
import { GUIDE_LINK_CLASS, GUIDE_PANEL_CLASS, GUIDE_TABLE_CLASS, GUIDE_TABLE_WRAP_CLASS, GUIDE_TD_CLASS, GUIDE_TD_NUM_CLASS, GUIDE_TH_CLASS, GUIDE_THEAD_CLASS } from "../guideUi";
import { fmtCount, fmtCountNoun, fmtPct, GUIDE_TREND_FLAT_THRESHOLD } from "@/lib/guides/format";
import type { GuideOpenerRow } from "@/lib/guides/types";

type RankedOpener = GuideOpenerRow & { rank: number };
const SORTS: Readonly<Record<string, GuideTableSort<RankedOpener>>> = {
  winRate: { label: "Win rate", pick: (row) => row.winRate, compare: (a, b, direction) => (direction === "desc" ? -1 : 1) * (a.winRate - b.winRate || a.ci.low - b.ci.low) },
  games: { label: "Games", pick: (row) => row.games },
  prevalence: { label: "Played in", pick: (row) => row.prevalence },
  trend: { label: "Trend", pick: (row) => row.trend?.winRateDelta },
};

function OpenerName({ row, matchupSlug, canLinkGuides }: { row: GuideOpenerRow; matchupSlug: string; canLinkGuides: boolean }) {
  return <>{canLinkGuides && row.published ? <Link href={guidePaths.build(matchupSlug, row.buildSlug)} className={GUIDE_LINK_CLASS}>{row.name}</Link> : <span className="text-text">{row.name}</span>}
    {canLinkGuides && !row.published ? <span className="block text-micro font-normal text-text-dim">Full guide once more games are in</span> : null}</>;
}

function PopularityMovement({ row }: { row: GuideOpenerRow }) {
  const delta = row.trend?.prevalenceDelta;
  if (delta == null || Math.abs(delta) < GUIDE_TREND_FLAT_THRESHOLD) return null;
  const movement = delta > 0 ? "more" : "less";
  return <span className="block text-micro text-text-dim"><span aria-hidden>{delta > 0 ? "↑" : "↓"} {(Math.abs(delta) * 100).toFixed(1)} pp {movement} popular</span><span className="sr-only">Played in {(Math.abs(delta) * 100).toFixed(1)} percentage points {movement} games than the previous week</span></span>;
}

function OpenerCards({ rows, matchupSlug, canLinkGuides }: { rows: RankedOpener[]; matchupSlug: string; canLinkGuides: boolean }) {
  return <ol aria-label="Opener cards" className="space-y-3 sm:hidden">{rows.map((row) => <li key={row.buildKey} value={row.rank} className={`${GUIDE_PANEL_CLASS} space-y-3 p-4`}>
    <p className="font-semibold text-text"><span className="mr-2 text-text-dim">#{row.rank}</span><OpenerName row={row} matchupSlug={matchupSlug} canLinkGuides={canLinkGuides} /></p>
    <div className="flex items-center justify-between gap-3"><span className="text-caption text-text-muted">Win rate</span><WinRateCell winRate={row.winRate} ci={row.ci} showWhisker={false} /></div>
    <div className="flex flex-wrap justify-between gap-3 text-caption text-text-muted"><span>{fmtCountNoun(row.games, "game")}</span><TrendBadge trend={row.trend} isNew={row.isNew} showDelta /></div>
    {row.prevalence != null ? <p className="text-caption text-text-muted">Played in {fmtPct(row.prevalence)}<PopularityMovement row={row} /></p> : null}
  </li>)}</ol>;
}

type Controls = ReturnType<typeof useGuideTableControls<RankedOpener>>;
function OpenerTable({ rows, id, caption, matchupSlug, canLinkGuides, hasPrevalence, sortProps }: {
  rows: RankedOpener[]; id: string; caption: string; matchupSlug: string; canLinkGuides: boolean; hasPrevalence: boolean; sortProps: Controls["sortProps"];
}) {
  const [scrolled, setScrolled] = useState(false);
  const sticky = `sticky left-0 z-10 bg-bg-surface ${scrolled ? "shadow-[3px_0_4px_rgb(0_0_0_/_0.2)]" : ""}`;
  return <div className={`hidden sm:block ${GUIDE_TABLE_WRAP_CLASS}`} onScroll={(event) => setScrolled(event.currentTarget.scrollLeft > 0)}>
    <table id={id} className={GUIDE_TABLE_CLASS}><caption className="sr-only">{caption}</caption><thead className={GUIDE_THEAD_CLASS}><tr>
      <th scope="col" className={GUIDE_TH_CLASS}>#</th><th scope="col" className={`${GUIDE_TH_CLASS} sticky left-0 z-10 bg-bg-elevated`}>Opener</th>
      {Object.entries(SORTS).filter(([key]) => key !== "prevalence" || hasPrevalence).map(([key, sort]) => <SortableTh key={key} col={key} label={sort.label} {...sortProps} align="right" />)}
    </tr></thead><tbody className="divide-y divide-border">{rows.map((row) => <tr key={row.buildKey}>
      <td className={`${GUIDE_TD_CLASS} w-8 tabular-nums text-text-dim`}>{row.rank}</td>
      <th scope="row" className={`${GUIDE_TD_CLASS} ${sticky} text-left font-medium`}><OpenerName row={row} matchupSlug={matchupSlug} canLinkGuides={canLinkGuides} /></th>
      <td className={GUIDE_TD_NUM_CLASS}><WinRateCell winRate={row.winRate} ci={row.ci} /></td>
      <td className={GUIDE_TD_NUM_CLASS}>{fmtCount(row.games)}<span className="block text-micro text-text-dim">{fmtCountNoun(row.users, "player")}</span></td>
      {hasPrevalence ? <td className={GUIDE_TD_NUM_CLASS}>{row.prevalence == null ? "—" : fmtPct(row.prevalence)}<PopularityMovement row={row} /></td> : null}
      <td className={GUIDE_TD_NUM_CLASS}><TrendBadge trend={row.trend} isNew={row.isNew} showDelta /></td>
    </tr>)}</tbody></table>
  </div>;
}

export function OpenersTable({ openers, matchupSlug, caption, canLinkGuides }: { openers: ReadonlyArray<GuideOpenerRow>; matchupSlug: string; caption: string; canLinkGuides: boolean }) {
  const id = useId(); const [onlyGuides, setOnlyGuides] = useState(false);
  const ranked = openers.slice(0, 30).map((row, index) => ({ ...row, rank: index + 1 }));
  const controls = useGuideTableControls(ranked, { sorts: SORTS, defaultSort: null, filterFn: (row, query) => normalizeGuideSearch(row.name).includes(query) && (!canLinkGuides || !onlyGuides || row.published) });
  const hasPrevalence = ranked.some((row) => row.prevalence != null);
  const mobileSort = controls.sortProps.sortBy ? `${controls.sortProps.sortBy}:${controls.sortProps.sortDir}` : "rank";
  return <div className="min-w-0 space-y-3">
    <div className="flex flex-wrap items-end gap-3">
      <label className="w-full min-w-0 text-caption font-semibold text-text sm:w-auto sm:flex-1">Find an opener<Input type="search" value={controls.query} maxLength={100} aria-controls={id} onChange={(event) => controls.setQuery(event.target.value)} /></label>
      {canLinkGuides ? <label className="flex min-h-11 items-center gap-2 text-caption text-text-muted"><input type="checkbox" checked={onlyGuides} onChange={(event) => setOnlyGuides(event.target.checked)} />Only openers with a full guide</label> : null}
      <p aria-live="polite" className="text-caption text-text-muted">{controls.count} of {ranked.length} openers</p>
    </div>
    <label className="block text-caption text-text sm:hidden">Sort by<select value={mobileSort} onChange={(event) => { const [key, direction] = event.target.value.split(":"); controls.setSortExplicit(key === "rank" ? "" : key, direction === "asc" ? "asc" : "desc"); }} className="ml-2 min-h-11 max-w-full rounded border border-line bg-bg-surface px-2">
      <option value="rank">Ranked</option>{Object.entries(SORTS).filter(([key]) => key !== "prevalence" || hasPrevalence).flatMap(([key, sort]) => [<option key={`${key}:desc`} value={`${key}:desc`}>{sort.label}: high to low</option>, <option key={`${key}:asc`} value={`${key}:asc`}>{sort.label}: low to high</option>])}
    </select></label>
    {!controls.count ? <p role="status" className={`${GUIDE_PANEL_CLASS} p-4 text-caption text-text`}>No opener matches “{controls.query}” <Button variant="secondary" size="sm" onClick={() => { controls.setQuery(""); setOnlyGuides(false); }}>Clear</Button></p> : null}
    <OpenerCards rows={controls.visibleRows} matchupSlug={matchupSlug} canLinkGuides={canLinkGuides} />
    <OpenerTable rows={controls.visibleRows} id={id} caption={caption} matchupSlug={matchupSlug} canLinkGuides={canLinkGuides} hasPrevalence={hasPrevalence} sortProps={controls.sortProps} />
  </div>;
}
