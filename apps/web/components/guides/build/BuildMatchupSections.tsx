import Link from "next/link";
import { GuideSection as Section } from "@/components/guides/GuideSection";
import { WinRateCell } from "@/components/guides/WinRateCell";
import { canLinkGuidePath, guidePaths } from "@/components/guides/guideMetadata";
import { BuildAllMaps, BuildMatchupGroup } from "./BuildMatchupTables";
import {
  GUIDE_LINK_CLASS,
  GUIDE_PANEL_CLASS,
  cellVerdict,
  verdictMeta,
} from "@/components/guides/guideUi";
import { fmtCount } from "@/lib/guides/format";
import type { GuideMapCell, GuideVsStrategyRow } from "@/lib/guides/types";

/**
 * Build guide sections 5 (what it beats / loses to, by opponent opener,
 * linking the counter pages) and 7 (best and worst maps, linking the
 * map pages). Rows are the API's published cells only. A build's map
 * cell only needs the cell floor while a map page needs the page floor,
 * so a map links only when its page is published (`publishedPaths`).
 */

const MAP_LIST_SIZE = 3;

/**
 * Opponent-opener rows ranked by the Wilson lower bound (the low end of
 * the likely range), never the raw win rate, so a thin cell with a lucky
 * streak cannot top the table; ties keep the payload order.
 *
 * Example: rows with ci.low 0.48 / 0.55 → the 0.55 row first.
 */
export function rankVsStrategyRows(rows: ReadonlyArray<GuideVsStrategyRow>): GuideVsStrategyRow[] {
  return rows
    .map((row, index) => ({ row, index }))
    .sort((a, b) => b.row.ci.low - a.row.ci.low || a.index - b.index)
    .map((entry) => entry.row);
}

export function BuildVsStrategySection({
  rows,
  matchupSlug,
}: {
  rows: ReadonlyArray<GuideVsStrategyRow>;
  matchupSlug: string;
}) {
  if (rows.length === 0) return null;
  const sorted = rankVsStrategyRows(rows);
  const groups = [
    { verdict: "win", label: "Favoured" },
    { verdict: "even", label: "Too close to call" },
    { verdict: "loss", label: "Unfavoured" },
  ] as const;
  return (
    <Section
      id="vs-openers"
      title="What it beats and loses to"
      description="Win rate against each opponent opener, ranked by the low end of its likely range."
    >
      <div className="space-y-6">{groups.map(({ verdict, label }) => {
        const grouped = sorted.filter((row) => cellVerdict(row) === verdict);
        return grouped.length ? <div key={verdict} className="space-y-2"><h3 className="text-body font-semibold text-text"><span aria-hidden>{verdictMeta(verdict).glyph} </span>{label} ({grouped.length})</h3><BuildMatchupGroup rows={grouped} matchupSlug={matchupSlug} label={label} collapsible={verdict !== "win"} /></div> : null;
      })}</div>
    </Section>
  );
}

function MapList({
  title,
  maps,
  publishedPaths,
}: {
  title: string;
  maps: ReadonlyArray<GuideMapCell>;
  publishedPaths: ReadonlySet<string> | null;
}) {
  return (
    <div className={`${GUIDE_PANEL_CLASS} min-w-0 p-4`}>
      <h3 className="mb-2 text-caption font-semibold uppercase tracking-wider text-text-dim">{title}</h3>
      <ul className="divide-y divide-border">
        {maps.map((map) => (
          <li key={map.mapSlug} className="flex items-center justify-between gap-3 py-2">
            <span className="min-w-0">
              {canLinkGuidePath(publishedPaths, guidePaths.map(map.mapSlug)) ? (
                <Link href={guidePaths.map(map.mapSlug)} className={`${GUIDE_LINK_CLASS} break-words`}>
                  {map.map}
                </Link>
              ) : (
                <span className="break-words text-text">{map.map}</span>
              )}
              <span className="block text-micro text-text-dim">{fmtCount(map.games)} games</span>
            </span>
            <WinRateCell winRate={map.winRate} ci={map.ci} showWhisker={false} />
          </li>
        ))}
      </ul>
    </div>
  );
}

/**
 * Best maps = highest interval floor; worst = lowest interval ceiling
 * among the rest, so a map is never listed twice.
 */
export function splitBestWorstMaps(maps: ReadonlyArray<GuideMapCell>): {
  best: GuideMapCell[];
  worst: GuideMapCell[];
} {
  const best = [...maps].sort((a, b) => b.ci.low - a.ci.low).slice(0, MAP_LIST_SIZE);
  const bestSlugs = new Set(best.map((map) => map.mapSlug));
  const worst = maps
    .filter((map) => !bestSlugs.has(map.mapSlug))
    .sort((a, b) => a.ci.high - b.ci.high)
    .slice(0, MAP_LIST_SIZE);
  return { best, worst };
}

export function BuildMapsSection({
  maps,
  publishedPaths,
}: {
  maps: ReadonlyArray<GuideMapCell>;
  publishedPaths: ReadonlySet<string> | null;
}) {
  if (maps.length === 0) return null;
  const { best, worst } = splitBestWorstMaps(maps);
  return (
    <Section id="maps" title="Best and worst maps">
      <div className="grid gap-4 md:grid-cols-2">
        <MapList title="Best maps" maps={best} publishedPaths={publishedPaths} />
        {worst.length > 0 ? <MapList title="Toughest maps" maps={worst} publishedPaths={publishedPaths} /> : null}
      </div>
      {maps.length > 6 ? <BuildAllMaps maps={maps} publishedPaths={publishedPaths === null ? null : [...publishedPaths]} /> : null}
    </Section>
  );
}
