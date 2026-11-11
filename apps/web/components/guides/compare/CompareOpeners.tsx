import Link from "next/link";
import type { ReactNode } from "react";
import { CiWhisker } from "@/components/guides/CiWhisker";
import { guidePaths } from "@/components/guides/guideMetadata";
import { GuideUnavailable } from "@/components/guides/GuideStates";
import { GUIDE_LINK_CLASS, GUIDE_PANEL_CLASS, GUIDE_TABLE_CLASS, GUIDE_TABLE_WRAP_CLASS, GUIDE_TD_CLASS, GUIDE_TH_CLASS, GUIDE_THEAD_CLASS, unitDisplayName } from "@/components/guides/guideUi";
import { WinRateCell } from "@/components/guides/WinRateCell";
import { milestoneText } from "@/components/guides/build/buildTimingFormat";
import { fmtUnitCount } from "@/components/guides/build/BuildArmySection";
import { splitBestWorstMaps } from "@/components/guides/build/BuildMatchupSections";
import { PageHeader } from "@/components/ui/PageHeader";
import { openerCompareHref } from "@/lib/guides/compareSelection";
import { fmtCi, fmtClock, fmtCountNoun, fmtPct } from "@/lib/guides/format";
import type { GuideBuildPublished, GuideMilestone } from "@/lib/guides/types";

export type ComparedOpener = { slug: string; build: GuideBuildPublished | null };

function columnName(column: ComparedOpener): string {
  return column.build?.name ?? column.slug;
}

function ComparisonTable({ title, columns, first, children }: {
  title: string; columns: readonly ComparedOpener[]; first: string; children: ReactNode;
}) {
  return <section aria-label={title} className="min-w-0 space-y-2">
    <h2 className="font-display text-h3 text-text">{title}</h2>
    {/* eslint-disable-next-line jsx-a11y/no-noninteractive-tabindex -- The named overflow region must accept keyboard scrolling. */}
    <div tabIndex={0} role="region" aria-label={title + " table"}
      className={GUIDE_TABLE_WRAP_CLASS + " focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"}>
      <table className={GUIDE_TABLE_CLASS}>
        <caption className="sr-only">{title}</caption>
        <thead className={GUIDE_THEAD_CLASS}><tr>
          <th scope="col" className={GUIDE_TH_CLASS + " sticky left-0 z-10 bg-bg-elevated"}>{first}</th>
          {columns.map((column) => <th scope="col" key={column.slug} className={GUIDE_TH_CLASS + " min-w-36"}>{columnName(column)}</th>)}
        </tr></thead>
        <tbody className="divide-y divide-border">{children}</tbody>
      </table>
    </div>
  </section>;
}

function CompareRow({ label, columns, cell }: {
  label: string; columns: readonly ComparedOpener[]; cell: (build: GuideBuildPublished) => ReactNode;
}) {
  return <tr>
    <th scope="row" className={GUIDE_TD_CLASS + " sticky left-0 z-10 bg-bg-surface text-left font-semibold"}>{label}</th>
    {columns.map(({ slug, build }) => <td className={GUIDE_TD_CLASS} key={slug}>{(build && cell(build)) ?? "—"}</td>)}
  </tr>;
}

function CompareHeader({ matchupSlug, columns }: { matchupSlug: string; columns: ComparedOpener[] }) {
  return <div className="grid gap-3 md:auto-cols-fr md:grid-flow-col">
    {columns.map((column) => {
      const remaining = columns.filter(({ slug }) => slug !== column.slug).map(({ slug }) => slug);
      const { build } = column;
      return <div key={column.slug} data-testid="compare-opener" className={GUIDE_PANEL_CLASS + " min-w-0 space-y-3 p-4"}>
        <h2 className="break-words font-display text-h4 text-text">{columnName(column)}</h2>
        {build ? <>
          <div className="flex flex-wrap items-baseline justify-between gap-2">
            <WinRateCell winRate={build.overall.winRate} ci={build.overall.ci} />
            <span className="text-caption text-text-muted">{fmtCountNoun(build.overall.games, "game")}</span>
          </div>
          <Link className={GUIDE_LINK_CLASS + " inline-flex min-h-11 items-center"} href={guidePaths.build(matchupSlug, column.slug)}>Read the full guide</Link>
        </> : <GuideUnavailable title="This opener is temporarily unavailable" />}
        <Link className={GUIDE_LINK_CLASS + " ml-3 inline-flex min-h-11 items-center"} aria-label={"Remove " + columnName(column)}
          href={openerCompareHref(matchupSlug, remaining)}>Remove</Link>
      </div>;
    })}
  </div>;
}

function CompareLeagueRows({ columns }: { columns: ComparedOpener[] }) {
  const bands = new Map(columns.flatMap(({ build }) => build?.bands.league.map(({ value, label }) => [value, label] as const) ?? []));
  return <ComparisonTable title="Record by opponent league" columns={columns} first="League">
    {bands.size ? [...bands].sort(([a], [b]) => a - b).map(([value, label]) => <CompareRow key={value} label={label} columns={columns} cell={(build) => {
      const cell = build.bands.league.find((band) => band.value === value);
      return cell ? <><CiWhisker cell={cell} /><span className="block text-caption tabular-nums">{fmtPct(cell.winRate)} · {fmtCi(cell.ci)}</span></> : null;
    }} />) : <CompareRow label="League sample" columns={columns} cell={() => null} />}
  </ComparisonTable>;
}

function TimingRow({ keyName, label, columns }: { keyName: string; label: string; columns: ComparedOpener[] }) {
  const byBuild = new Map<string, GuideMilestone>();
  for (const { build } of columns) {
    const timing = build?.timings?.milestones.find(({ key }) => key === keyName);
    if (build && timing) byBuild.set(build.buildSlug, timing);
  }
  const earliest = Math.min(...[...byBuild.values()].map(({ median }) => median));
  return <CompareRow label={label} columns={columns} cell={(build) => {
    const timing = byBuild.get(build.buildSlug);
    return timing ? <>
      <span className="tabular-nums">{fmtClock(timing.median)}</span>
      {byBuild.size > 1 && timing.median === earliest ? <span className="ml-2 text-micro text-text-muted">earliest</span> : null}
      <span className="block text-micro tabular-nums text-text-muted">{fmtClock(timing.p25)}–{fmtClock(timing.p75)}</span>
    </> : null;
  }} />;
}

function CompareTimingsTable({ columns }: { columns: ComparedOpener[] }) {
  const milestones = new Map(columns.flatMap(({ build }) =>
    build?.timings?.milestones.map((milestone) => [milestone.key, milestoneText(milestone)] as const) ?? []));
  return <ComparisonTable title="Key timings" columns={columns} first="Milestone">
    {milestones.size ? [...milestones].map(([key, label]) => <TimingRow key={key} keyName={key} label={label} columns={columns} />)
      : <CompareRow label="Timing sample" columns={columns} cell={() => null} />}
  </ComparisonTable>;
}

function CompareMaps({ columns }: { columns: ComparedOpener[] }) {
  return <ComparisonTable title="Maps" columns={columns} first="Map record">
    {[false, true].map((toughest) => <CompareRow key={String(toughest)} label={toughest ? "Toughest three" : "Best three"} columns={columns} cell={(build) => {
      const { best, worst } = splitBestWorstMaps(build.maps);
      const maps = toughest ? worst : best;
      return maps.length ? <ul className="space-y-1">
        {maps.map((map) => <li key={map.mapSlug}>{map.map} · {fmtPct(map.winRate)}</li>)}
      </ul> : null;
    }} />)}
  </ComparisonTable>;
}

function CompareArmy({ columns }: { columns: ComparedOpener[] }) {
  return <ComparisonTable title="Army at 8:00" columns={columns} first="Army composition">
    <CompareRow label="Most common units" columns={columns} cell={(build) => {
      const units = build.army?.["480"]?.units;
      return units?.length ? <ul className="space-y-1">
        {units.slice(0, 5).map((unit) => <li key={unit.unit}>{unitDisplayName(unit.unit)} ×{fmtUnitCount(unit.median)}</li>)}
      </ul> : null;
    }} />
  </ComparisonTable>;
}

export function CompareOpeners({ matchup, matchupSlug, columns, truncated }: {
  matchup: string; matchupSlug: string; columns: ComparedOpener[]; truncated: boolean;
}) {
  return <div className="min-w-0 space-y-6">
    <PageHeader title={"Compare " + matchup + " openers"}
      description="Win rates and timings from 12-worker ladder games."
      actions={<Link className={GUIDE_LINK_CLASS + " inline-flex min-h-11 items-center"} href={guidePaths.matchup(matchupSlug)}>Back to matchup</Link>} />
    {truncated ? <p role="status" className="text-caption text-text-muted">Showing the first 3 openers.</p> : null}
    <CompareHeader matchupSlug={matchupSlug} columns={columns} />
    <CompareLeagueRows columns={columns} />
    <CompareTimingsTable columns={columns} />
    <CompareMaps columns={columns} />
    <CompareArmy columns={columns} />
  </div>;
}
