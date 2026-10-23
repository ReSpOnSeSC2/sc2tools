"use client";

import { useEffect, useMemo, useRef, useState, type ReactNode, type CSSProperties } from "react";
import { ChevronDown, ChevronRight } from "lucide-react";
import { Card } from "@/components/ui/Card";
import { RequestError } from "@/components/ui/RequestError";
import { Icon } from "@/components/ui/Icon";
import {
  normalizeBuildEvents,
  type BuildEventRow,
} from "@/lib/build-events";
import type { GameBuildOrderEvent } from "./types";
import { BuildExportMenu } from "@/components/builds/BuildExportMenu";
import { withBuildSupply, type BuildExportMeta } from "@/lib/gameExport";
import { Input } from "@/components/ui/Input";

type Workspace = {
  myMeta: BuildExportMeta; oppMeta: BuildExportMeta;
  myStats?: readonly { time: number; food_used?: number }[];
  oppStats?: readonly { time: number; food_used?: number }[];
  mySaveAction?: ReactNode; oppAction?: ReactNode;
};

export interface BuildOrderColumnsProps {
  workspace?: Workspace;
  onSeek?: (time: number) => void;
  currentTime?: number;
  error?: unknown;
  onRetry?: () => unknown;
  myEvents?: GameBuildOrderEvent[] | null;
  oppEvents?: GameBuildOrderEvent[] | null;
  myLabel?: string | null;
  oppLabel?: string | null;
  myStatus?: "ok" | "empty" | "not_extracted";
  oppStatus?: "ok" | "empty" | "not_extracted";
  myHeadingLabel?: string;
  opponentHeadingLabel?: string;
  loading?: boolean;
  /** Optional action row rendered at the top of the MY column body
   *  (e.g. the Ghost Build "Arm this build" affordance). */
  myAction?: ReactNode;
}

const CATEGORY_DOT: Record<string, string> = {
  unit: "bg-accent-cyan",
  building: "bg-accent",
  upgrade: "bg-warning",
  other: "bg-text-dim",
};

function visibleRows(rows: BuildEventRow[], workers: boolean, supplyBuildings: boolean, filter: string) {
  const query = filter.trim().toLowerCase();
  return rows.filter(row => {
    const entity = (row.iconName || row.rawName).replace(/[^a-z0-9]/gi, "").toLowerCase();
    return (workers || !/^(scv|drone|probe)$/.test(entity)) && (supplyBuildings || !/^(pylon|supplydepot(?:lowered)?|overlord)$/.test(entity)) && `${row.displayName} ${row.rawName}`.toLowerCase().includes(query);
  });
}

/**
 * BuildOrderColumns — my build vs the opponent's, side by side.
 * Events come from GET /v1/games/:id/build-order (the same `[m:ss]
 * Name` build-log lines, parsed server-side) and are normalized
 * through lib/build-events.ts so icons and display names match every
 * other build surface in the app.
 *
 * Mobile: the columns stack and each is collapsible; desktop always
 * shows both expanded. Long lists scroll inside the column, never the
 * page.
 */
export function BuildOrderColumns({
  error, onRetry, workspace,
  myEvents,
  oppEvents,
  myLabel,
  oppLabel,
  myStatus,
  oppStatus,
  myHeadingLabel = "You",
  opponentHeadingLabel = "Opponent",
  loading,
  myAction,
  onSeek,
  currentTime,
}: BuildOrderColumnsProps) {
  const [autoScroll, setAutoScroll] = useState(false);
  const [workers, setWorkers] = useState(false), [supplyBuildings, setSupplyBuildings] = useState(true), [filter, setFilter] = useState("");
  const lists = useRef<Record<string, HTMLOListElement | null>>({});
  const enhanced = !!workspace, myStats = workspace?.myStats, oppStats = workspace?.oppStats;
  const myRows = useMemo(() => { const rows = normalizeBuildEvents(enhanced ? withBuildSupply(myEvents || [], myStats) : myEvents); return enhanced ? rows.sort((a, b) => a.time - b.time) : rows; }, [myEvents, myStats, enhanced]);
  const oppRows = useMemo(() => { const rows = normalizeBuildEvents(enhanced ? withBuildSupply(oppEvents || [], oppStats) : oppEvents); return enhanced ? rows.sort((a, b) => a.time - b.time) : rows; }, [oppEvents, oppStats, enhanced]);
  const mine = useMemo(() => enhanced ? visibleRows(myRows, workers, supplyBuildings, filter) : myRows, [myRows, enhanced, workers, supplyBuildings, filter]);
  const theirs = useMemo(() => enhanced ? visibleRows(oppRows, workers, supplyBuildings, filter) : oppRows, [oppRows, enhanced, workers, supplyBuildings, filter]);
  const slots = useMemo(() => {
    if (!enhanced) return undefined;
    const counts = new Map<number, [number, number]>();
    for (const [side, rows] of [mine, theirs].entries()) for (const row of rows) { const count = counts.get(row.time) || [0, 0]; count[side]++; counts.set(row.time, count); }
    return [...counts].sort(([a], [b]) => a - b).map(([time, count]) => ({ time, count: Math.max(...count) }));
  }, [mine, theirs, enhanced]);
  const syncScroll = (source: string) => { const current = lists.current[source]; if (!current || !window.matchMedia("(min-width: 768px)").matches) return; for (const [key, list] of Object.entries(lists.current)) if (key !== source && list && Math.abs(list.scrollTop - current.scrollTop) > 1) list.scrollTop = current.scrollTop; };

  if (error) return <RequestError title="Couldn't load build orders" error={error} onRetry={onRetry} />;
  if (loading) {
    return (
      <Card title="Build orders">
        <div
          className="grid gap-4 md:grid-cols-2"
          aria-busy="true"
          aria-label="Loading build orders"
        >
          {[0, 1].map((col) => (
            <div key={col} className="space-y-2">
              {Array.from({ length: 6 }).map((_, i) => (
                <div
                  key={i}
                  className="h-4 animate-pulse rounded bg-bg-elevated"
                />
              ))}
            </div>
          ))}
        </div>
      </Card>
    );
  }

  return (
    <Card title="Build orders" right={onSeek ? <label className="inline-flex min-h-11 items-center gap-2 text-caption"><input type="checkbox" checked={autoScroll} onChange={(event) => setAutoScroll(event.target.checked)} />Follow current step</label> : undefined} data-testid="build-order-columns">
      {workspace ? <div className="mb-3 flex flex-wrap items-center gap-x-4 gap-y-2">
        <label className="inline-flex min-h-11 items-center gap-2 text-caption"><input type="checkbox" checked={workers} onChange={event => setWorkers(event.target.checked)} />Show workers</label>
        <label className="inline-flex min-h-11 items-center gap-2 text-caption"><input type="checkbox" checked={supplyBuildings} onChange={event => setSupplyBuildings(event.target.checked)} />Supply buildings</label>
        <Input aria-label="Filter steps" placeholder="Filter steps…" value={filter} onChange={event => setFilter(event.target.value)} className="w-full sm:w-56" />
        <p className="w-full text-micro text-text-muted">Supply ≈ uses the last recorded sample before the step. Missing supply stays —.</p>
      </div> : null}
      <div className="grid gap-4 md:grid-cols-2">
        <BuildColumn
          heading={`${myHeadingLabel} — ${(myLabel || "").trim() || "Unclassified"}`}
          rows={mine}
          totalRows={myRows.length} slots={slots} showSupply={!!workspace} listRef={list => { lists.current.me = list; }} onListScroll={() => syncScroll("me")}
          menu={workspace ? <BuildExportMenu meta={workspace.myMeta} steps={mine.map(row => ({ ...row, name: row.rawName, display: row.displayName }))} extraActions={<>{myAction}{workspace.mySaveAction}</>} /> : undefined}
          status={myStatus}
          testId="build-column-me"
          action={workspace ? undefined : myAction}
          onSeek={onSeek} currentTime={currentTime} autoScroll={autoScroll}
        />
        <BuildColumn
          heading={`${opponentHeadingLabel} — ${(oppLabel || "").trim() || "Unknown"}`}
          rows={theirs}
          totalRows={oppRows.length} slots={slots} showSupply={!!workspace} listRef={list => { lists.current.opp = list; }} onListScroll={() => syncScroll("opp")}
          menu={workspace ? <BuildExportMenu meta={workspace.oppMeta} steps={theirs.map(row => ({ ...row, name: row.rawName, display: row.displayName }))} extraActions={workspace.oppAction} /> : undefined}
          status={oppStatus}
          testId="build-column-opp"
          onSeek={onSeek} currentTime={currentTime} autoScroll={autoScroll}
        />
      </div>
    </Card>
  );
}

function BuildColumn({
  heading,
  rows, menu, showSupply, slots, totalRows, listRef, onListScroll,
  status,
  testId,
  action,
  onSeek,
  currentTime,
  autoScroll,
}: {
  heading: string;
  menu?: ReactNode; showSupply?: boolean; totalRows?: number;
  slots?: { time: number; count: number }[];
  listRef?: (list: HTMLOListElement | null) => void; onListScroll?: () => void;
  rows: BuildEventRow[];
  status?: "ok" | "empty" | "not_extracted";
  testId: string;
  action?: ReactNode;
  onSeek?: (time: number) => void;
  currentTime?: number;
  autoScroll: boolean;
}) {
  // Collapsed state only applies below md — the body keeps `md:block`
  // so desktop always shows both columns expanded.
  const [collapsed, setCollapsed] = useState(false);
  const list = useRef<HTMLOListElement>(null);
  const rowsByTime = useMemo(() => {
    const groups = new Map<number, BuildEventRow[]>();
    for (const row of rows) { const group = groups.get(row.time) || []; group.push(row); groups.set(row.time, group); }
    return groups;
  }, [rows]);
  const active = currentTime == null ? null : rows.filter((row) => row.time <= currentTime).at(-1)?.key;
  useEffect(() => {
    const container = list.current; const row = container?.querySelector<HTMLElement>('[aria-current="step"]');
    if (!autoScroll || !container || !row) return;
    const outer = container.getBoundingClientRect(); const inner = row.getBoundingClientRect();
    if (inner.top >= outer.top && inner.bottom <= outer.bottom) return;
    container.scrollTop += inner.top - outer.top - Math.max(0, (outer.height - inner.height) / 2);
  }, [active, autoScroll, collapsed]);

  return (
    <section
      className="min-w-0 rounded-lg border border-border bg-bg-elevated/40"
      data-testid={testId}
    >
      <div className={`flex items-center justify-between gap-2 pr-2 ${showSupply ? "min-h-[60px]" : "min-h-[44px]"}`}><div className="min-w-0 flex-1"><button
        type="button"
        onClick={() => setCollapsed((c) => !c)}
        aria-expanded={!collapsed}
        className="flex min-h-[44px] w-full items-center justify-between gap-2 px-3 py-2 text-left md:hidden"
      >
        <h4 className="truncate text-caption font-semibold text-text">
          {heading}
        </h4>
        <span className="text-text-dim md:hidden" aria-hidden>
          {collapsed ? (
            <ChevronRight className="h-4 w-4" />
          ) : (
            <ChevronDown className="h-4 w-4" />
          )}
        </span>
      </button>
      <h4 className={`hidden items-center px-3 py-2 text-caption font-semibold text-text md:flex ${showSupply ? "h-[60px] overflow-hidden" : "min-h-[44px]"}`}>{showSupply ? <span className="line-clamp-2" title={heading}>{heading}</span> : heading}</h4></div>{menu}</div>
      <div
        className={[
          "border-t border-border px-3 py-2",
          collapsed ? "hidden md:block" : "block",
        ].join(" ")}
      >
        {action && rows.length > 0 ? (
          <div className="flex justify-end pb-1">{action}</div>
        ) : null}
        {showSupply ? <div className="mb-1 flex gap-2 px-1 text-micro text-text-dim"><span className="w-11 text-right">Time</span><span className="w-12 text-right">Supply</span><span>Step</span></div> : null}
        {rows.length === 0 ? (
          <p className="py-3 text-caption text-text-muted">
            {totalRows ? "No steps match these filters." : status === "not_extracted"
              ? "The agent hasn't extracted this build log yet — a resync from the desktop agent fills it in."
              : "No build events were parsed from this replay."}
          </p>
        ) : (
          <ol ref={element => { list.current = element; listRef?.(element); }} onScroll={onListScroll} className={`max-h-96 overflow-y-auto pr-1 ${slots ? "" : "space-y-0.5"}`}>
            {(slots || rows.map(row => ({ time: row.time, count: 1, key: row.key }))).map((slot, slotIndex) => {
              const group = slots ? rowsByTime.get(slot.time) || [] : [rows[slotIndex]];
              return <li key={slots ? slot.time : group[0].key} className={group.length ? "" : "hidden md:block"}>
                <div className={slots ? "md:min-h-[var(--build-slot-height)]" : undefined} style={slots ? { "--build-slot-height": `${slot.count * 44}px` } as CSSProperties : undefined}>
            {group.map(row => (
              <div key={row.key}>
                {onSeek ? <button type="button" aria-label={`Jump to ${row.timeDisplay} ${row.displayName}`} aria-current={active === row.key ? "step" : undefined} onClick={() => onSeek(row.time)} className={`flex min-h-11 w-full items-center gap-2 rounded px-1 py-0.5 text-left text-caption focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent ${active === row.key ? "bg-accent/10" : "hover:bg-bg-elevated"}`}><BuildEventContent row={row} showSupply={showSupply} /></button> : <span className="flex items-center gap-2 rounded px-1 py-0.5 text-caption"><BuildEventContent row={row} showSupply={showSupply} /></span>}
              </div>
            ))}</div></li>; })}
          </ol>
        )}
      </div>
    </section>
  );
}

function BuildEventContent({ row, showSupply }: { row: BuildEventRow; showSupply?: boolean }) {
  return <>
                <span className="w-11 flex-shrink-0 text-right font-mono text-micro tabular-nums text-text-dim">
                  {row.timeDisplay}
                </span>
                {showSupply ? <span className="w-12 flex-shrink-0 text-right font-mono text-micro tabular-nums text-text-muted" title={row.supplyApprox ? "Approximate supply from the last recorded sample" : undefined}>{row.supply == null ? "—" : `${row.supplyApprox ? "≈" : ""}${row.supply}`}</span> : null}
                {row.iconPath && row.iconName ? (
                  <Icon
                    name={row.iconName}
                    kind={row.iconKind ?? undefined}
                    size={18}
                    fallback=""
                    decorative
                  />
                ) : (
                  <span
                    className={`inline-block h-2 w-2 flex-shrink-0 rounded-full ${
                      CATEGORY_DOT[row.category] || CATEGORY_DOT.other
                    }`}
                    aria-hidden
                  />
                )}
                <span className="truncate text-text" title={row.rawName}>
                  {row.displayName}
                </span>
  </>;
}
