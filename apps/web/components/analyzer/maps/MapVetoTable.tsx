"use client";

import { MapLabel } from "@/components/maps/MapArtwork";
import { WinRateCell } from "@/components/guides/WinRateCell";
import { pct1, wrRamp } from "@/lib/format";
import { communityMapRate, mapRecord, type MapRecord, type VetoMap } from "@/lib/mapVeto";
import type { GuideIndexMap } from "@/lib/guides/types";

export type MapGamesDrill = { map: string; maps?: string[]; opponent?: string; filters?: Record<string, unknown> };
const COLUMNS = ["P", "T", "Z", ""];

function Form({ values, matchup }: { values?: ("win" | "loss")[]; matchup: string }) {
  if (!values?.length) return <span className="text-micro text-text-dim">Recent form unavailable</span>;
  return <span role="img" aria-label={`Recent ${matchup ? `vs ${matchup}` : "all matchups"}, oldest to newest: ${values.join(", ")}`} className="flex flex-wrap gap-1">
    {values.map((value, index) => <span key={index} aria-hidden className={`h-2 w-2 rounded-sm ${value === "win" ? "bg-success" : "bg-danger"}`} />)}
  </span>;
}

export function MapRecordCell({ record, community, onClick, label }: { record: MapRecord; community: number | null; onClick: () => void; label: string }) {
  const tint = record.winRate === null ? null : wrRamp(record.winRate);
  return <button type="button" onClick={onClick} aria-label={label} className="flex min-h-11 w-full flex-col items-end gap-1 rounded-lg border border-transparent p-2 text-right transition-colors hover:border-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
    style={tint && record.decided >= 5 ? { backgroundColor: `rgb(${tint.join(" ")} / 0.12)` } : undefined}>
    <span className="text-caption tabular-nums"><span className="text-success">{record.wins}W</span> · <span className="text-danger">{record.losses}L</span></span>
    {record.winRate !== null && record.ci ? <WinRateCell winRate={record.winRate} ci={record.ci} compact /> : <span className="text-caption text-text-dim">No decided games</span>}
    <span className="text-micro text-text-muted">n={record.decided} decided{record.total > record.decided ? ` · ${record.total - record.decided} ties/other` : ""}</span>
    {community !== null ? <span className="text-micro text-text-dim">Community {pct1(community)}{record.winRate !== null ? ` · ${record.winRate >= community ? "+" : ""}${((record.winRate - community) * 100).toFixed(1)}pp` : ""}</span> : null}
  </button>;
}

export function MapVetoTable({ rows, suggested, matchup, mine, community, openGames }: {
  rows: readonly VetoMap[]; suggested: readonly string[]; matchup: string; mine: string;
  community: readonly GuideIndexMap[]; openGames: (drill: MapGamesDrill) => void;
}) {
  return <div className="min-w-0 space-y-2"><p className="text-micro text-text-dim sm:hidden">Swipe across the table to compare matchups.</p><div className="relative max-w-full overflow-x-auto rounded-xl border border-border"><table className="w-full min-w-[760px] text-caption">
    <caption className="sr-only">Current ladder map pool, personal record and community comparison</caption>
    <thead className="bg-bg-elevated text-text-muted"><tr><th scope="col" className="sticky left-0 z-10 w-44 bg-bg-elevated p-3 text-left">Map</th>{COLUMNS.map((race) => <th scope="col" key={race} className={`p-2 text-right ${race === matchup ? "text-accent" : ""}`}>{race ? `vs ${race}` : "All"}{race === matchup ? " · ranking" : ""}</th>)}</tr></thead>
    <tbody className="divide-y divide-border">{rows.map((row) => {
      const ranked = matchup ? row.cells[matchup] : row.all;
      return <tr key={row.name}><th scope="row" className="sticky left-0 z-10 space-y-2 bg-bg-surface p-3 text-left align-top font-normal">
        <button type="button" className="min-h-11 rounded text-left font-semibold text-text hover:text-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent" onClick={() => openGames({ map: row.gameMap, maps: row.gameMaps.length ? row.gameMaps : [row.name] })} aria-label={`View games on ${row.name}`}><MapLabel name={row.name} size="sm" /></button>
        {suggested.includes(row.name) ? <span className="block text-micro font-semibold text-warning">Suggested veto</span> : (ranked?.decided ?? 0) < 5 ? <span className="block text-micro text-text-dim">Not enough games</span> : null}
        <Form values={row.recent} matchup={matchup} />
      </th>{COLUMNS.map((race) => <td key={race} className={`p-1 align-top ${race === matchup ? "bg-accent/5" : ""}`}><MapRecordCell record={race ? row.cells[race] ?? mapRecord() : row.all}
        community={communityMapRate(community, row.name, mine, race)} label={`View ${race ? `vs ${race}` : "all"} games on ${row.name}`} onClick={() => openGames({ map: row.gameMap, maps: row.gameMaps.length ? row.gameMaps : [row.name], opponent: race || undefined })} /></td>)}</tr>;
    })}</tbody>
  </table></div></div>;
}
