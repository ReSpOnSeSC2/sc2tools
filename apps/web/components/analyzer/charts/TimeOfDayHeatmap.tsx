"use client";

import { useMemo, useRef, useState, type KeyboardEvent } from "react";
import { useTrendsApi as useApi, useTrendsDataScope } from "@/lib/trendsDataContext";
import { TrendsRequestError } from "./TrendsRequestError";
import { useFilters, filtersToQuery } from "@/lib/filterContext";
import { Card, EmptyState, Skeleton } from "@/components/ui/Card";
import { clientTimezone } from "@/lib/timeseries";

type HeatmapCell = { dow: number; hour: number; wins: number; losses: number; total: number; winRate: number };
type HeatmapResponse = { timezone: string; cells: HeatmapCell[]; totalGames: number };
type CellAgg = { total: number; wins: number; losses: number };
const DAY_LABELS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"] as const;
const MIN_RATE_GAMES = 20;
const BLOCK_COUNT = 6;

function formatHourBlock(start: number, end: number, hour12: boolean): string {
  if (!hour12) return `${String(start).padStart(2, "0")}–${String(end).padStart(2, "0")}`;
  const meridiem = (hour: number) => hour < 12 || hour === 24 ? "a" : "p";
  const display = (hour: number) => hour % 12 || 12;
  return meridiem(start) === meridiem(end)
    ? `${display(start)}–${display(end)}${meridiem(end)}`
    : `${display(start)}${meridiem(start)}–${display(end)}${meridiem(end)}`;
}

const rateClass = (rate: number) => rate < 0.45
  ? "bg-warning/25 text-text"
  : rate > 0.55 ? "bg-accent-cyan/30 text-text" : "bg-border text-text";

/** Each mode encodes one measure. Sparse cells never advertise a strong win rate. */
export function TimeOfDayHeatmap() {
  const { filters, dbRev } = useFilters();
  const { isGlobal } = useTrendsDataScope();
  const recordLabel = isGlobal ? "player game records" : "games";
  const tz = useMemo(() => clientTimezone(), []);
  const hour12 = useMemo(() => {
    try { return new Intl.DateTimeFormat(undefined, { hour: "numeric" }).resolvedOptions().hour12 ?? true; }
    catch { return true; }
  }, []);
  const labels = useMemo(() => Array.from({ length: BLOCK_COUNT }, (_, i) => formatHourBlock(i * 4, (i + 1) * 4, hour12)), [hour12]);
  const params = useMemo(() => ({ ...filters, tz }), [filters, tz]);
  const { data, isLoading, error, mutate } = useApi<HeatmapResponse>(`/v1/timeseries/day-hour${filtersToQuery(params)}#${dbRev}`);
  const [mode, setMode] = useState<"wr" | "volume">("volume");
  const [selection, setSelection] = useState<number | null>(null);
  const cellRefs = useRef<Array<HTMLButtonElement | null>>([]);
  const cells = useMemo(() => {
    const out: CellAgg[] = Array.from({ length: 7 * BLOCK_COUNT }, () => ({ total: 0, wins: 0, losses: 0 }));
    for (const cell of data?.cells ?? []) {
      if (!Number.isInteger(cell.dow) || !Number.isInteger(cell.hour) || cell.dow < 0 || cell.dow > 6 || cell.hour < 0 || cell.hour > 23) continue;
      const slot = out[cell.dow * BLOCK_COUNT + Math.floor(cell.hour / 4)];
      slot.total += cell.total || 0;
      slot.wins += cell.wins || 0;
      slot.losses += cell.losses || 0;
    }
    return out;
  }, [data]);
  const peakIndex = cells.reduce((best, cell, index) => cell.total > cells[best].total ? index : best, 0);
  const selectedIndex = selection ?? peakIndex;
  const selected = cells[selectedIndex];
  const maxTotal = cells[peakIndex].total;
  const selectedLabel = `${DAY_LABELS[Math.floor(selectedIndex / BLOCK_COUNT)]} ${labels[selectedIndex % BLOCK_COUNT]}`;
  const onCellKeyDown = (event: KeyboardEvent<HTMLButtonElement>, index: number) => {
    let next = index;
    if (event.key === "ArrowRight") next = Math.min(cells.length - 1, index + 1);
    else if (event.key === "ArrowLeft") next = Math.max(0, index - 1);
    else if (event.key === "ArrowDown") next = Math.min(cells.length - 1, index + BLOCK_COUNT);
    else if (event.key === "ArrowUp") next = Math.max(0, index - BLOCK_COUNT);
    else if (event.key === "Home") next = Math.floor(index / BLOCK_COUNT) * BLOCK_COUNT;
    else if (event.key === "End") next = Math.floor(index / BLOCK_COUNT) * BLOCK_COUNT + BLOCK_COUNT - 1;
    else return;
    event.preventDefault();
    cellRefs.current[next]?.focus();
  };
  if (error) return <TrendsRequestError title="Activity by time of day" error={error} retry={mutate} />;
  if (isLoading) return <Card title="Activity by time of day"><Skeleton rows={3} /></Card>;
  if (!data || !maxTotal) return <Card title="Activity by time of day"><EmptyState title="No games to plot" sub="The day and time grid fills in when the selected records include games." /></Card>;

  return (
    <Card title="Activity by time of day" className="min-w-0">
      <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
        <p className="text-caption text-text-muted">Four-hour blocks · {data.timezone || "UTC"}</p>
        <div className="inline-flex rounded-lg border border-border bg-bg-elevated p-0.5" role="group" aria-label="Time of day measure">
          {(["volume", "wr"] as const).map((value) => <button key={value} type="button" aria-pressed={mode === value} onClick={() => setMode(value)} className={`min-h-11 rounded-md px-3 text-caption font-medium focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent ${mode === value ? "bg-accent text-white" : "text-text-muted hover:text-text"}`}>{value === "volume" ? "Games played" : "Win rate"}</button>)}
        </div>
      </div>
      <p className="mb-3 text-micro leading-relaxed text-text-muted">
        {mode === "volume" ? `Stronger color means more ${recordLabel}. Select a cell for its results.` : `Rates appear after ${MIN_RATE_GAMES} ${recordLabel} in a cell; smaller samples show a dash. Counts remain visible below each rate.`}
      </p>
      <div className="overflow-x-auto pb-1">
        <table className="w-full min-w-[320px] table-fixed border-separate border-spacing-1 text-micro" aria-label={`Day and time by ${mode === "volume" ? "games played" : "win rate"}`}>
          <thead><tr><th className="w-8"><span className="sr-only">Day</span></th>{labels.map((label) => <th scope="col" key={label} className="pb-1 font-medium tabular-nums text-text-muted">{label}</th>)}</tr></thead>
          <tbody>{DAY_LABELS.map((day, dow) => <tr key={day}>
            <th scope="row" className="text-left font-medium text-text-muted">{day}</th>
            {cells.slice(dow * BLOCK_COUNT, (dow + 1) * BLOCK_COUNT).map((cell, block) => {
              const index = dow * BLOCK_COUNT + block;
              const rate = cell.total ? cell.wins / cell.total : 0;
              const ready = cell.total >= MIN_RATE_GAMES;
              const empty = cell.total === 0;
              const details = empty ? "no games" : `${cell.total} ${recordLabel}, ${cell.wins} wins, ${cell.losses} losses, ${Math.round(rate * 100)}% win rate${!ready ? ", small sample" : ""}`;
              return <td key={block} className="p-0">
                <button type="button" ref={(node) => { cellRefs.current[index] = node; }} aria-label={`${day} ${labels[block]}: ${details}`} aria-pressed={index === selectedIndex} tabIndex={index === selectedIndex ? 0 : -1} onFocus={() => setSelection(index)} onClick={() => setSelection(index)} onKeyDown={(event) => onCellKeyDown(event, index)}
                  className={`relative flex min-h-11 w-full flex-col items-center justify-center overflow-hidden rounded-md border text-micro tabular-nums focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent ${index === selectedIndex ? "border-text" : "border-transparent"} ${mode === "wr" && ready ? rateClass(rate) : "bg-bg-elevated text-text"}`}>
                  {mode === "volume" && !empty && <span aria-hidden="true" className="absolute inset-0 bg-accent" style={{ opacity: 0.1 + cell.total / maxTotal * 0.5 }} />}
                  <span className="relative font-semibold">{empty ? "·" : mode === "volume" ? cell.total.toLocaleString() : ready ? `${Math.round(rate * 100)}%` : "—"}</span>
                  {mode === "wr" && !empty && <span className="relative text-[10px] leading-3 text-text-muted">{cell.total.toLocaleString()} {isGlobal ? "rec" : "g"}</span>}
                </button>
              </td>;
            })}
          </tr>)}</tbody>
        </table>
      </div>
      <div className="mt-3 flex flex-wrap gap-x-3 gap-y-2 text-micro text-text-muted" aria-label="Color legend">
        {mode === "volume" ? <span>Few → many · busiest cell: {maxTotal.toLocaleString()} {recordLabel}</span> : <>
          <span className="rounded bg-warning/25 px-2 py-1 text-text">Below 45%</span>
          <span className="rounded bg-border px-2 py-1 text-text">45–55%</span>
          <span className="rounded bg-accent-cyan/30 px-2 py-1 text-text">Above 55%</span>
          <span className="self-center">— under {MIN_RATE_GAMES} {isGlobal ? "records" : "games"}</span>
        </>}
      </div>
      <div role="status" aria-live="polite" aria-atomic="true" className="mt-3 rounded-lg border border-border bg-bg-elevated/50 p-3 text-caption">
        <div className="flex flex-wrap items-baseline justify-between gap-2"><strong className="text-text">{selectedLabel}</strong><span className="tabular-nums text-text-muted">{selected.total.toLocaleString()} {recordLabel}</span></div>
        {selected.total ? <p className="mt-1 tabular-nums text-text-muted">{selected.wins}W · {selected.losses}L{selected.total > selected.wins + selected.losses ? ` · ${selected.total - selected.wins - selected.losses} other` : ""} · {(selected.wins / selected.total * 100).toFixed(1)}% win rate{selected.total < MIN_RATE_GAMES ? " · Small sample" : ""}</p> : <p className="mt-1 text-text-muted">No selected games in this time block.</p>}
      </div>
      <p className="mt-2 text-micro leading-relaxed text-text-muted">These are observed results, not a best-time recommendation. Opponents and matchups can vary by time.{isGlobal ? " Results combine the selected players." : ""} Use arrow keys to explore the grid.</p>
    </Card>
  );
}
