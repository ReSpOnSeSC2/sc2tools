"use client";

import { useEffect, useRef, useState, type ReactNode } from "react";
import { fmtAgo, pct1 } from "@/lib/format";
import type { OpponentGroup } from "@/lib/opponentGroups";
import { opponentRowWindow } from "@/lib/opponentRivalries";
import { OPPONENT_DETAIL_COLUMNS, OPPONENT_EXTRA_COLUMNS, opponentRegion, type OpponentColumns } from "@/lib/opponentPresentation";
import { useMediaQuery } from "@/lib/useChartTheme";
import { SortableTh, type SortState } from "@/components/ui/SortableTh";
import { Button } from "@/components/ui/Button";
import { Select } from "@/components/ui/Select";
import { Skeleton } from "@/components/ui/Card";
import { InfoTip } from "@/components/ui/InfoTip";
import { PlayerChannelLinks } from "../PlayerChannelLinks";
import type { usePlayerChannels } from "../usePlayerChannels";
import { AliasChip, IdentityRow, NotePreview, OpponentLink, OpponentRow } from "./OpponentTableRows";
import { OpponentRace } from "./OpponentRace";
import { RevealedChip } from "../RevealedChip";
import { type Opp, type OpenOpponent, notePreview } from "./types";
import { OpponentDetailCells, UNSORTED_OPPONENT_COLUMNS } from "./OpponentDetailColumns";

const EXTRA_COLUMNS = [{ key: "pulseId", label: "Pulse ID", termId: "pulse-id" }, { key: "mmr", label: "Last MMR", termId: "last-mmr" }, { key: "netMmr", label: "Net MMR", termId: "net-mmr" }, { key: "mmrWon", label: "MMR won", termId: "mmr-won" }, { key: "mmrLost", label: "MMR lost", termId: "mmr-lost" }] as const;
const MOBILE_SORTS = [
  { key: "lastPlayed", label: "Last played" }, { key: "games", label: "Games" },
  { key: "wins", label: "Wins" }, { key: "losses", label: "Losses" }, { key: "winRate", label: "Win rate" },
  { key: "netMmr", label: "Net MMR" }, { key: "name", label: "Name" }, { key: "race", label: "Race" },
  ...OPPONENT_EXTRA_COLUMNS.filter(column => column.key !== "netMmr" && !UNSORTED_OPPONENT_COLUMNS.has(column.key)),
];
function useColumnPickerPosition() {
  const ref = useRef<HTMLDetailsElement>(null);
  const [open, setOpen] = useState(false);
  useEffect(() => {
    if (!open) return;
    let frame = 0;
    const place = () => {
      frame = 0;
      const details = ref.current, panel = details?.querySelector("fieldset");
      if (!details?.open || !panel) return;
      const anchor = details.querySelector("summary")!.getBoundingClientRect();
      const rootStyle = getComputedStyle(document.documentElement);
      const chromeBottom = Math.max(0, parseFloat(rootStyle.getPropertyValue("--chrome-bottom")) || 0);
      const edge = innerHeight - chromeBottom;
      const above = Math.max(0, Math.min(anchor.top, edge) - 8), below = Math.max(0, edge - Math.max(anchor.bottom, 8) - 8);
      const desired = Math.min(innerHeight * .7, 34 * (parseFloat(rootStyle.fontSize) || 16), panel.scrollHeight);
      const upward = below < desired && above > below;
      panel.style.top = upward ? "auto" : `calc(100% + ${Math.max(4, 8 - anchor.bottom)}px)`;
      panel.style.bottom = upward ? `calc(100% + ${Math.max(4, anchor.top - edge + 4)}px)` : "auto";
      panel.style.maxHeight = `min(70dvh,34rem,${upward ? above : below}px)`;
    };
    const schedule = () => { if (!frame) frame = requestAnimationFrame(place); };
    place();
    window.addEventListener("resize", schedule);
    window.addEventListener("scroll", schedule, true);
    return () => {
      cancelAnimationFrame(frame);
      window.removeEventListener("resize", schedule);
      window.removeEventListener("scroll", schedule, true);
    };
  }, [open]);
  return { ref, setOpen };
}
export function OpponentColumnPicker({ columns, onChange, onReset }: { columns: OpponentColumns; onChange: (key: keyof OpponentColumns, checked: boolean) => void; onReset: () => void }) {
  const position = useColumnPickerPosition();
  return <details ref={position.ref} className="relative" onToggle={event => position.setOpen(event.currentTarget.open)} onKeyDown={event => { if (event.key === "Escape") { event.currentTarget.open = false; event.currentTarget.querySelector("summary")?.focus(); } }}><summary className="flex min-h-11 cursor-pointer items-center rounded-lg border border-line px-3 text-caption">Columns</summary><fieldset className="absolute right-0 z-30 max-h-[min(70dvh,34rem)] w-72 max-w-[calc(100vw-2rem)] overflow-y-auto rounded-xl border-2 border-line bg-bg-elevated p-3 shadow-hard"><legend className="sr-only">Opponent columns</legend><p className="mb-3 text-caption text-text-muted">Saved automatically in this browser.</p>{Array.from(new Set(OPPONENT_EXTRA_COLUMNS.map(column => column.group))).map(group => <div key={group} className="mb-3"><p className="text-micro font-bold uppercase tracking-wide text-text-dim">{group}</p>{OPPONENT_EXTRA_COLUMNS.filter(column => column.group === group).map(column => <label key={column.key} className="flex min-h-11 items-center gap-2 text-caption"><input type="checkbox" checked={!!columns[column.key]} onChange={event => onChange(column.key, event.target.checked)} />{column.label}</label>)}</div>)}<Button size="sm" variant="ghost" onClick={onReset}>Reset columns</Button></fieldset></details>;
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
      <label className="flex items-center gap-3 p-3 text-caption">Sort opponents<Select aria-label="Sort opponents" value={MOBILE_SORTS.some(option => option.key === sort.sortBy) ? sort.sortBy : "lastPlayed"} onChange={event => sort.setSortExplicit(event.target.value, ["name", "race", "region", "map", "myBuild", "opponentBuild", "lastResult"].includes(event.target.value) ? "asc" : "desc")} className="min-h-11 flex-1">{MOBILE_SORTS.map(option => <option key={option.key} value={option.key}>{option.label}</option>)}</Select><Button variant="ghost" aria-label="Reverse sort direction" onClick={() => sort.setSortExplicit(sort.sortBy, sort.sortDir === "asc" ? "desc" : "asc")}>{sort.sortDir === "asc" ? "↑" : "↓"}</Button></label>
      <ul aria-label="Opponent history" aria-busy={busy || undefined} className="divide-y divide-line">
        {loading ? <li className="p-3"><Skeleton rows={8} /></li> : rows.map(entry => <li key={`${entry.kind}:${entry.row.pulseId}`} className={entry.kind === "identity" ? "border-l-4 border-l-accent/30 bg-bg-elevated p-3 pl-6" : "p-3"}>
          <MobileOpponent row={entry.row} onOpen={onOpen} onPrefetch={onPrefetch} />
          <div className="mt-1 flex flex-wrap items-center gap-1 [&_a]:min-h-11">
            {entry.kind === "parent" ? <>{star(entry.row)}{entry.row.groupSize > 1 ? <AliasChip group={entry.row} expanded={expanded.has(entry.row.pulseId)} onToggle={() => onToggle(entry.row.pulseId)} /> : null}</> : null}
            <NotePreview previews={(entry.kind === "parent" ? entry.row.identities : [entry.row]).map(notePreview).filter(Boolean)} />
            <PlayerChannelLinks channels={channelsFor(entry.row)} playerName={entry.row.name} compact />
          </div>
          <OpponentDetailCells row={entry.row} columns={columns} mobile />
        </li>)}
      </ul>
    </> : <div className="relative overflow-x-auto"><table aria-label="Opponent history" className="w-full text-sm [&_thead_th:first-child]:sticky [&_thead_th:first-child]:left-0 [&_thead_th:first-child]:z-20 [&_thead_th:first-child]:bg-bg-elevated" style={{ minWidth: 640 + extra * 88 }}>
      <thead className="bg-bg-elevated"><tr>
        <SortableTh col="name" label="Opponent" {...sort} compact width="12rem" />
        <SortableTh col="race" label="Race" {...sort} compact width="4rem" />
        {columns.pulseId ? <SortableTh col="pulseId" label="Pulse ID" {...sort} compact info={<InfoTip termId="pulse-id" label="Pulse ID" />} /> : null}
        <SortableTh col="wins" label="W" title="Wins" {...sort} compact align="right" />
        <SortableTh col="losses" label="L" title="Losses" {...sort} compact align="right" />
        <SortableTh col="winRate" label="Win rate" {...sort} compact align="right" info={<InfoTip termId="opponent-win-rate" label="Win rate" />} />
        <SortableTh col="games" label="Games" {...sort} compact align="right" />
        {EXTRA_COLUMNS.slice(1).map(column => columns[column.key] ? <SortableTh key={column.key} col={column.key} label={column.label} {...sort} compact align="right" info={<InfoTip termId={column.termId} label={column.label} />} /> : null)}
        {OPPONENT_DETAIL_COLUMNS.map(column => columns[column.key] ? UNSORTED_OPPONENT_COLUMNS.has(column.key) ? <th key={column.key} className="px-2 py-1.5 text-left text-micro font-semibold uppercase tracking-wide text-text-muted">{column.label}</th> : <SortableTh key={column.key} col={column.key} label={column.label} {...sort} compact /> : null)}
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
