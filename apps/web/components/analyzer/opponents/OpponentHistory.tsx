"use client";

import type { ReactNode } from "react";
import { fmtAgo, pct1 } from "@/lib/format";
import type { OpponentGroup } from "@/lib/opponentGroups";
import { opponentRowWindow } from "@/lib/opponentRivalries";
import { opponentRegion, type OpponentColumns } from "@/lib/opponentPresentation";
import { useMediaQuery } from "@/lib/useChartTheme";
import { SortableTh, type SortState } from "@/components/ui/SortableTh";
import { Button } from "@/components/ui/Button";
import { Select } from "@/components/ui/Select";
import { Skeleton } from "@/components/ui/Card";
import { PlayerChannelLinks } from "../PlayerChannelLinks";
import type { usePlayerChannels } from "../usePlayerChannels";
import { AliasChip, IdentityRow, NotePreview, OpponentLink, OpponentRow } from "./OpponentTableRows";
import { OpponentRace } from "./OpponentRace";
import { RevealedChip } from "../RevealedChip";
import { type Opp, type OpenOpponent, notePreview } from "./types";

const EXTRA_COLUMNS = [{ key: "pulseId", label: "Pulse ID" }, { key: "mmr", label: "Last MMR" }, { key: "netMmr", label: "Net MMR" }, { key: "mmrWon", label: "MMR won" }, { key: "mmrLost", label: "MMR lost" }] as const;
export function OpponentColumnPicker({ columns, onChange, onReset }: { columns: OpponentColumns; onChange: (key: keyof OpponentColumns, checked: boolean) => void; onReset: () => void }) {
  return <details className="relative"><summary className="flex min-h-11 cursor-pointer items-center rounded-lg border border-line px-3 text-caption">Columns</summary><fieldset className="absolute right-0 z-30 min-w-48 rounded-xl border-2 border-line bg-bg-elevated p-3 shadow-hard"><legend className="sr-only">Opponent columns</legend>{EXTRA_COLUMNS.map(column => <label key={column.key} className="flex min-h-11 items-center gap-2 text-caption"><input type="checkbox" checked={columns[column.key]} onChange={event => onChange(column.key, event.target.checked)} />{column.label}</label>)}<Button size="sm" variant="ghost" onClick={onReset}>Reset columns</Button></fieldset></details>;
}

export function OpponentHistory({ items, expanded, visibleCount, onMore, sort, columns, onToggle, onOpen, onPrefetch, channelsFor, star, loading, busy }: {
  items: OpponentGroup<Opp>[]; expanded: ReadonlySet<string>; visibleCount: number; onMore: () => void; sort: SortState; columns: OpponentColumns;
  onToggle: (id: string) => void; onOpen: OpenOpponent; onPrefetch: (id: string | null) => void; channelsFor: ReturnType<typeof usePlayerChannels>;
  star: (row: OpponentGroup<Opp>) => ReactNode; loading: boolean; busy: boolean;
}) {
  const mobile = useMediaQuery("(max-width: 767px)");
  const { window: rows, total } = opponentRowWindow(items, expanded, visibleCount);
  const extra = Object.values(columns).filter(Boolean).length;
  return <div className="rounded-xl border-2 border-line bg-bg-surface shadow-hard">
    {mobile ? <>
      <label className="flex items-center gap-3 p-3 text-caption">Sort opponents<Select aria-label="Sort opponents" value={["lastPlayed", "games", "winRate", "netMmr", "name", "race"].includes(sort.sortBy) ? sort.sortBy : "lastPlayed"} onChange={event => sort.setSortExplicit(event.target.value, event.target.value === "name" || event.target.value === "race" ? "asc" : "desc")} className="min-h-11 flex-1"><option value="lastPlayed">Last played</option><option value="games">Games</option><option value="winRate">Win rate</option><option value="netMmr">Net MMR</option><option value="name">Name</option><option value="race">Race</option></Select><Button variant="ghost" aria-label="Reverse sort direction" onClick={() => sort.setSortExplicit(sort.sortBy, sort.sortDir === "asc" ? "desc" : "asc")}>{sort.sortDir === "asc" ? "↑" : "↓"}</Button></label>
      <ul aria-label="Opponent history" aria-busy={busy || undefined} className="divide-y divide-line">
        {loading ? <li className="p-3"><Skeleton rows={8} /></li> : rows.map(entry => <li key={`${entry.kind}:${entry.row.pulseId}`} className={entry.kind === "identity" ? "border-l-4 border-l-accent/30 bg-bg-elevated p-3 pl-6" : "p-3"}>
          <MobileOpponent row={entry.row} onOpen={onOpen} onPrefetch={onPrefetch} />
          <div className="mt-1 flex flex-wrap items-center gap-1 [&_a]:min-h-11">
            {entry.kind === "parent" ? <>{star(entry.row)}{entry.row.groupSize > 1 ? <AliasChip group={entry.row} expanded={expanded.has(entry.row.pulseId)} onToggle={() => onToggle(entry.row.pulseId)} /> : null}</> : null}
            <NotePreview previews={(entry.kind === "parent" ? entry.row.identities : [entry.row]).map(notePreview).filter(Boolean)} />
            <PlayerChannelLinks channels={channelsFor(entry.row)} playerName={entry.row.name} compact />
          </div>
        </li>)}
      </ul>
    </> : <div className="overflow-x-auto"><table aria-label="Opponent history" className="w-full text-sm [&_thead_th:first-child]:sticky [&_thead_th:first-child]:left-0 [&_thead_th:first-child]:z-20 [&_thead_th:first-child]:bg-bg-elevated" style={{ minWidth: 640 + extra * 88 }}>
      <thead className="bg-bg-elevated"><tr>
        <SortableTh col="name" label="Opponent" {...sort} compact width="12rem" />
        <SortableTh col="race" label="Race" {...sort} compact width="4rem" />
        {columns.pulseId ? <SortableTh col="pulseId" label="Pulse ID" {...sort} compact /> : null}
        <SortableTh col="wins" label="W" title="Wins" {...sort} compact align="right" />
        <SortableTh col="losses" label="L" title="Losses" {...sort} compact align="right" />
        <SortableTh col="winRate" label="Win rate" {...sort} compact align="right" />
        <SortableTh col="games" label="Games" {...sort} compact align="right" />
        {EXTRA_COLUMNS.slice(1).map(column => columns[column.key] ? <SortableTh key={column.key} col={column.key} label={column.label} {...sort} compact align="right" /> : null)}
        <SortableTh col="lastPlayed" label="Last" {...sort} compact align="right" />
        <th className="px-1 py-2"><span className="sr-only">Open dossier</span><span aria-hidden>→</span></th>
      </tr></thead>
      <tbody aria-busy={busy || undefined} className={busy ? "opacity-70" : undefined}>
        {loading ? <tr><td colSpan={8 + extra} className="p-3"><Skeleton rows={8} /></td></tr> : rows.map(entry => entry.kind === "identity" ? <IdentityRow key={`identity:${entry.row.pulseId}`} identity={entry.row} channels={channelsFor(entry.row)} onOpen={onOpen} onPrefetch={onPrefetch} columns={columns} /> : <OpponentRow key={entry.row.pulseId} row={entry.row} expanded={expanded.has(entry.row.pulseId)} onToggle={onToggle} onOpen={onOpen} onPrefetch={onPrefetch} channelsFor={channelsFor} columns={columns} star={star(entry.row)} />)}
      </tbody>
    </table></div>}
    {!loading ? <div className="flex flex-wrap items-center justify-between gap-2 p-3"><span className="text-caption text-text-dim">{rows.length.toLocaleString()} of {total.toLocaleString()} rows shown</span>{total > visibleCount ? <Button variant="secondary" onClick={onMore}>Show 100 more</Button> : null}</div> : null}
  </div>;
}

function MobileOpponent({ row, onOpen, onPrefetch }: { row: Opp; onOpen: OpenOpponent; onPrefetch: (id: string | null) => void }) {
  const decided = row.wins + row.losses;
  return <OpponentLink opponent={row} onOpen={onOpen} onPointerEnter={() => onPrefetch(row.pulseId)} onPointerLeave={() => onPrefetch(null)} className="block min-h-11 rounded-lg text-text focus-visible:ring-2 focus-visible:ring-accent">
    <span className="flex min-w-0 flex-wrap items-center gap-2"><span className="min-w-0 flex-1 truncate font-semibold">{row.name || "unnamed"}</span><OpponentRace row={row} />{opponentRegion(row) ? <span className="text-micro text-text-dim">{opponentRegion(row)}</span> : null}<span aria-hidden>→</span></span>
    <RevealedChip name={row.globalIdentity?.displayName || row.revealedName} displayedName={row.name} confirmed={!!row.globalIdentity} />
    <span className="my-2 flex h-1.5 overflow-hidden rounded-full bg-bg-elevated" aria-hidden><span className="bg-success" style={{ width: decided ? `${100 * row.wins / decided}%` : "0%" }} /><span className="bg-danger" style={{ width: decided ? `${100 * row.losses / decided}%` : "0%" }} /></span>
    <span className="flex flex-wrap justify-between gap-2 text-caption"><span><span className="sr-only">Wins–losses: </span>{row.wins}–{row.losses} · {pct1(row.winRate)} · {row.games} games</span><span className={`rounded-full border border-line px-1.5 tabular-nums ${typeof row.netMmr === "number" && row.netMmr < 0 ? "text-danger" : "text-text-muted"}`}>{(row.mmrPairs || 0) > 0 && typeof row.netMmr === "number" ? `${row.netMmr > 0 ? "+" : ""}${row.netMmr} MMR` : "MMR unmeasured"}</span></span>
    <span className="mt-1 block text-caption text-text-dim">Last played {row.lastPlayed ? <time dateTime={row.lastPlayed} title={new Date(row.lastPlayed).toLocaleString()}>{fmtAgo(row.lastPlayed)}</time> : "unknown"}</span>
  </OpponentLink>;
}
