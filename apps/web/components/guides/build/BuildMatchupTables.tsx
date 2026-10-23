"use client";

import { useId, useState } from "react";
import Link from "next/link";
import { Button } from "@/components/ui/Button";
import { SortableTh } from "@/components/ui/SortableTh";
import { WinRateCell } from "../WinRateCell";
import { guidePaths, canLinkGuidePath } from "../guideMetadata";
import { useGuideTableControls } from "../useGuideTableControls";
import { GUIDE_LINK_CLASS, GUIDE_TABLE_CLASS, GUIDE_TABLE_WRAP_CLASS, GUIDE_TD_CLASS, GUIDE_TD_NUM_CLASS, GUIDE_TH_CLASS, GUIDE_THEAD_CLASS } from "../guideUi";
import { fmtCount } from "@/lib/guides/format";
import type { GuideMapCell, GuideVsStrategyRow } from "@/lib/guides/types";

const GROUP_SORTS = { winRate: { label: "Win rate", pick: (row: GuideVsStrategyRow) => row.winRate }, games: { label: "Games", pick: (row: GuideVsStrategyRow) => row.games } };
const MAP_SORTS = { name: { label: "Map", pick: (row: GuideMapCell) => row.map }, winRate: { label: "Win rate", pick: (row: GuideMapCell) => row.winRate }, games: { label: "Games", pick: (row: GuideMapCell) => row.games } };

export function BuildMatchupGroup({ rows, matchupSlug, label, collapsible }: { rows: ReadonlyArray<GuideVsStrategyRow>; matchupSlug: string; label: string; collapsible: boolean }) {
  const [expanded, setExpanded] = useState(false); const id = useId();
  const controls = useGuideTableControls(rows, { sorts: GROUP_SORTS, defaultSort: null, filterFn: () => true });
  const shown = collapsible && !expanded ? controls.visibleRows.slice(0, 5) : controls.visibleRows;
  return <div className="space-y-2">
    <div className={GUIDE_TABLE_WRAP_CLASS}><table className={GUIDE_TABLE_CLASS} aria-label={`${label} opponent openers`}><thead className={GUIDE_THEAD_CLASS}><tr>
      <th scope="col" className={GUIDE_TH_CLASS}>Opponent opener</th>{Object.entries(GROUP_SORTS).map(([key, sort]) => <SortableTh key={key} col={key} label={sort.label} {...controls.sortProps} align="right" />)}
    </tr></thead><tbody id={id} className="divide-y divide-border">{shown.map((row) => <tr key={row.strategyKey}>
      <th scope="row" className={`${GUIDE_TD_CLASS} text-left font-medium`}>{row.published ? <Link href={guidePaths.counter(matchupSlug, row.strategySlug)} className={GUIDE_LINK_CLASS}>{row.name}</Link> : row.name}</th>
      <td className={GUIDE_TD_NUM_CLASS}><WinRateCell winRate={row.winRate} ci={row.ci} /></td><td className={GUIDE_TD_NUM_CLASS}>{fmtCount(row.games)}</td>
    </tr>)}</tbody></table></div>
    {collapsible && rows.length > 5 ? <Button variant="secondary" size="sm" aria-controls={id} aria-expanded={expanded} onClick={() => setExpanded((value) => !value)}>{expanded ? "Show fewer" : `Show ${rows.length - 5} more`}</Button> : null}
  </div>;
}

export function BuildAllMaps({ maps, publishedPaths }: { maps: ReadonlyArray<GuideMapCell>; publishedPaths: ReadonlyArray<string> | null }) {
  const controls = useGuideTableControls(maps, { sorts: MAP_SORTS, defaultSort: { by: "winRate", direction: "desc" }, filterFn: () => true });
  const published = publishedPaths === null ? null : new Set(publishedPaths);
  return <details className="mt-4"><summary className="min-h-11 cursor-pointer py-3 text-caption font-semibold text-accent">Show all {maps.length} maps</summary>
    <div className={GUIDE_TABLE_WRAP_CLASS}><table className={GUIDE_TABLE_CLASS}><caption className="sr-only">All maps for this build</caption><thead className={GUIDE_THEAD_CLASS}><tr>{Object.entries(MAP_SORTS).map(([key, sort]) => <SortableTh key={key} col={key} label={sort.label} {...controls.sortProps} align={key === "name" ? "left" : "right"} compact />)}</tr></thead>
      <tbody className="divide-y divide-border">{controls.visibleRows.map((map) => <tr key={map.mapSlug}><th scope="row" className={`${GUIDE_TD_CLASS} text-left font-medium`}>{canLinkGuidePath(published, guidePaths.map(map.mapSlug)) ? <Link href={guidePaths.map(map.mapSlug)} className={GUIDE_LINK_CLASS}>{map.map}</Link> : map.map}</th><td className={GUIDE_TD_NUM_CLASS}><WinRateCell winRate={map.winRate} ci={map.ci} showWhisker={false} compact /></td><td className={GUIDE_TD_NUM_CLASS}>{fmtCount(map.games)}</td></tr>)}</tbody>
    </table></div>
  </details>;
}
