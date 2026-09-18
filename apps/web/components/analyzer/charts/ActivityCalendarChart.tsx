"use client";

import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from "react";
import { useTrendsApi as useApi, useTrendsDataScope } from "@/lib/trendsDataContext";
import { TrendsRequestError } from "./TrendsRequestError";
import { useFilters, filtersToQuery } from "@/lib/filterContext";
import { Card, EmptyState, Skeleton } from "@/components/ui/Card";
import { clientTimezone, localDateKey } from "@/lib/timeseries";
import { formatTrendDate } from "@/lib/winRateTrend";

type ActivityDay = { day: string; wins: number; losses: number; total: number; winRate: number };
type ActivityResponse = { timezone: string; days: ActivityDay[] };
type CalCell = { date: string; wins: number; losses: number; total: number };
const DAY_LABELS = ["Mon", "", "Wed", "", "Fri", "", "Sun"];
const MS_PER_DAY = 86_400_000;
const VOLUME_LEVELS = [
  { label: "0", className: "bg-bg-elevated" },
  { label: "1–2", className: "bg-accent/20" },
  { label: "3–5", className: "bg-accent/40" },
  { label: "6–9", className: "bg-accent/60" },
  { label: "10+", className: "bg-accent" },
];
const level = (total: number) => total === 0 ? 0 : total < 3 ? 1 : total < 6 ? 2 : total < 10 ? 3 : 4;
// Date-only filters are already local calendar dates, not midnight UTC instants.
const calendarKey = (value: string, zone: string) => /^\d{4}-\d{2}-\d{2}$/.test(value) ? value : localDateKey(value, zone);

/** A calendar answers "when did I play?"; outcomes belong in its selected-day readout. */
export function ActivityCalendarChart({ weeks = 26 }: { weeks?: number }) {
  const { filters, dbRev } = useFilters();
  const { isGlobal } = useTrendsDataScope();
  const recordLabel = isGlobal ? "player game records" : "games";
  const tz = useMemo(() => clientTimezone(), []);
  const params = useMemo(() => ({ ...filters, tz }), [filters, tz]);
  const { data, isLoading, error, mutate } = useApi<ActivityResponse>(`/v1/activity-calendar${filtersToQuery(params)}#${dbRev}`);
  const calendar = useMemo(() => {
    const zone = data?.timezone || tz;
    const dayMap = new Map<string, CalCell>();
    for (const day of data?.days ?? []) {
      const date = calendarKey(day.day, zone);
      if (date) dayMap.set(date, { date, wins: day.wins, losses: day.losses, total: day.total });
    }
    const today = localDateKey(new Date(), zone);
    const until = filters.until ? calendarKey(filters.until, zone) : today;
    const since = filters.since ? calendarKey(filters.since, zone) : "";
    return buildCalendar(dayMap, weeks, until && until < today ? until : today, since);
  }, [data, filters.since, filters.until, tz, weeks]);
  const visible = useMemo(() => calendar.flat().filter((cell): cell is CalCell => cell != null), [calendar]);
  const totalGames = visible.reduce((sum, cell) => sum + cell.total, 0);
  const activeDays = visible.filter((cell) => cell.total > 0).length;
  const [selectedDate, setSelectedDate] = useState<string | null>(null);
  const selected = visible.find((cell) => cell.date === selectedDate)
    ?? [...visible].reverse().find((cell) => cell.total > 0) ?? visible[visible.length - 1];
  const scroller = useRef<HTMLDivElement | null>(null);
  const cellRefs = useRef(new Map<string, HTMLButtonElement>());
  const endDate = visible[visible.length - 1]?.date;
  useEffect(() => {
    if (scroller.current) scroller.current.scrollLeft = scroller.current.scrollWidth;
  }, [endDate, isLoading]);

  const onCellKeyDown = (event: KeyboardEvent<HTMLButtonElement>, cell: CalCell) => {
    const index = visible.findIndex((entry) => entry.date === cell.date);
    let next = index;
    if (event.key === "ArrowRight") next += 7;
    else if (event.key === "ArrowLeft") next -= 7;
    else if (event.key === "ArrowDown") next += 1;
    else if (event.key === "ArrowUp") next -= 1;
    else if (event.key === "Home") next = 0;
    else if (event.key === "End") next = visible.length - 1;
    else return;
    event.preventDefault();
    cellRefs.current.get(visible[Math.max(0, Math.min(visible.length - 1, next))]?.date)?.focus();
  };
  if (error) return <TrendsRequestError title="Activity calendar" error={error} retry={mutate} />;
  if (isLoading) return <Card title="Activity calendar"><Skeleton rows={3} /></Card>;
  if (!data?.days.some((day) => day.total > 0)) return <Card title="Activity calendar"><EmptyState title="No activity to plot" sub="The calendar fills in when the selected records include at least one game." /></Card>;

  const months = calendar.map((week, index) => {
    const first = week.find((cell) => cell != null);
    const previous = calendar[index - 1]?.find((cell) => cell != null);
    if (!first || (index > 0 && index < 3) || first.date.slice(0, 7) === previous?.date.slice(0, 7)) return "";
    return new Date(`${first.date}T12:00:00Z`).toLocaleDateString(undefined, { month: "short", ...(index === 0 || first.date.slice(0, 4) !== previous?.date.slice(0, 4) ? { year: "2-digit" as const } : {}), timeZone: "UTC" });
  });
  return (
    <Card title="Activity calendar" className="min-w-0">
      <div className="mb-2 flex flex-wrap items-baseline gap-x-4 gap-y-1">
        <span className="text-caption font-semibold tabular-nums text-text">{totalGames.toLocaleString()} {recordLabel} shown</span>
        <span className="text-caption tabular-nums text-text-muted">{activeDays} active {activeDays === 1 ? "day" : "days"} / {visible.length} shown</span>
      </div>
      <p className="mb-3 text-micro leading-relaxed text-text-muted">
        {visible.length > 0 ? `${formatTrendDate(visible[0].date, true)} – ${formatTrendDate(visible[visible.length - 1].date, true)}. ` : ""}
        Stronger color means more {recordLabel}. Showing up to {Math.max(1, Math.floor(weeks))} recent weeks within your date range.
      </p>
      <div ref={scroller} className="overflow-x-auto pb-2" aria-label="Activity calendar, older weeks on the left">
        <div className="flex w-max gap-2">
          <div aria-hidden="true" className="sticky left-0 z-10 bg-bg-surface pr-1 text-micro text-text-muted">
            <div className="h-5" />
            {DAY_LABELS.map((label, i) => <div key={i} className="flex h-6 items-center mb-0.5">{label}</div>)}
          </div>
          <div className="flex gap-0.5">
            {calendar.map((week, wi) => <div key={wi}>
              <div aria-hidden="true" className="h-5 w-6 whitespace-nowrap text-micro text-text-muted">{months[wi]}</div>
              {week.map((cell, di) => cell ? <button key={cell.date} type="button"
                ref={(node) => { if (node) cellRefs.current.set(cell.date, node); else cellRefs.current.delete(cell.date); }}
                aria-label={`${cell.date}: ${cell.total} ${recordLabel}, ${cell.wins} wins, ${cell.losses} losses`}
                aria-pressed={selected?.date === cell.date} tabIndex={selected?.date === cell.date ? 0 : -1}
                onClick={() => setSelectedDate(cell.date)} onFocus={() => setSelectedDate(cell.date)} onKeyDown={(event) => onCellKeyDown(event, cell)}
                className={`mb-0.5 block h-6 w-6 rounded border focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent ${VOLUME_LEVELS[level(cell.total)].className} ${selected?.date === cell.date ? "border-text" : "border-border/40"}`} />
                : <div key={di} aria-hidden="true" className="mb-0.5 h-6 w-6" />)}
            </div>)}
          </div>
        </div>
      </div>
      <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-2 text-micro text-text-muted">
        <span>{isGlobal ? "Records" : "Games"} per day</span>
        {VOLUME_LEVELS.map((item) => <span key={item.label} className="inline-flex items-center gap-1"><span aria-hidden="true" className={`h-3 w-3 rounded border border-border/40 ${item.className}`} />{item.label}</span>)}
      </div>
      {selected && <div role="status" aria-live="polite" aria-atomic="true" className="mt-3 rounded-lg border border-border bg-bg-elevated/50 p-3 text-caption">
        <div className="flex flex-wrap justify-between gap-2"><strong className="text-text">{formatTrendDate(selected.date, true)}</strong><span className="tabular-nums text-text-muted">{selected.total.toLocaleString()} {recordLabel}</span></div>
        <p className="mt-1 tabular-nums text-text-muted">{selected.total ? `${selected.wins}W · ${selected.losses}L${selected.total > selected.wins + selected.losses ? ` · ${selected.total - selected.wins - selected.losses} other` : ""}` : "No selected games on this day."}</p>
      </div>}
      <p className="mt-2 text-micro text-text-muted">Select a day for results. Scroll for older weeks; arrow keys explore days.{isGlobal ? " Activity combines the selected players." : ""}</p>
    </Card>
  );
}

/** Calendar arithmetic uses date-only UTC keys, avoiding DST duplicates and gaps. */
function buildCalendar(dayMap: Map<string, CalCell>, weeks: number, end: string, since: string): Array<Array<CalCell | null>> {
  const endMs = Date.parse(`${end}T00:00:00Z`);
  const endDow = (new Date(endMs).getUTCDay() + 6) % 7;
  const count = Number.isFinite(weeks) ? Math.max(1, Math.min(104, Math.floor(weeks))) : 26;
  const lastSunday = endMs + (6 - endDow) * MS_PER_DAY;
  let startMs = lastSunday - (count * 7 - 1) * MS_PER_DAY;
  const sinceMs = since ? Date.parse(`${since}T00:00:00Z`) : NaN;
  if (Number.isFinite(sinceMs) && sinceMs > startMs) startMs = sinceMs - ((new Date(sinceMs).getUTCDay() + 6) % 7) * MS_PER_DAY;
  const out: Array<Array<CalCell | null>> = [];
  for (let week = startMs; week <= lastSunday; week += MS_PER_DAY * 7) {
    out.push(Array.from({ length: 7 }, (_, offset) => {
      const date = new Date(week + offset * MS_PER_DAY).toISOString().slice(0, 10);
      if (date > end || (since && date < since)) return null;
      return dayMap.get(date) ?? { date, wins: 0, losses: 0, total: 0 };
    }));
  }
  return out;
}
