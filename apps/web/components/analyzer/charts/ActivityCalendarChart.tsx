"use client";

import { useMemo } from "react";
import { useApi } from "@/lib/clientApi";
import { useFilters, filtersToQuery } from "@/lib/filterContext";
import { Card, EmptyState, Skeleton } from "@/components/ui/Card";
import { wrRamp } from "@/lib/format";
import { clientTimezone, localDateKey } from "@/lib/timeseries";

type ActivityDay = {
  day: string;
  wins: number;
  losses: number;
  total: number;
  winRate: number;
};

type ActivityResponse = {
  timezone: string;
  days: ActivityDay[];
};

// Row 0 is Monday (mondayBasedDow); show labels on alternating rows
// starting at Mon so the labels actually line up with the cells they
// describe instead of slipping a row late.
const DAY_LABELS = ["Mon", "", "Wed", "", "Fri", "", ""] as const;
const MS_PER_DAY = 24 * 60 * 60 * 1000;

/**
 * GitHub-style contribution graph for SC2 games.
 *
 * Each square is a day; column = ISO week, row = day-of-week (Mon top
 * → Sun bottom). Cell colour blends two signals: hue carries win rate
 * (red → amber → green), saturation carries volume (more games =
 * more saturated). Empty days are flat dark.
 *
 * Hovering a cell shows the date + W-L-WR. Doubles as a "consistency"
 * indicator without dedicating a chart to it.
 */
export function ActivityCalendarChart({
  weeks = 26,
}: {
  weeks?: number;
}) {
  const { filters, dbRev } = useFilters();
  const tz = useMemo(() => clientTimezone(), []);
  const params = useMemo(() => ({ ...filters, tz }), [filters, tz]);
  const { data, isLoading } = useApi<ActivityResponse>(
    `/v1/activity-calendar${filtersToQuery(params)}#${dbRev}`,
  );

  const calendar = useMemo(() => {
    const dayMap = new Map<string, ActivityDay>();
    for (const d of data?.days || []) {
      const key = localDateKey(d.day, tz);
      if (key) dayMap.set(key, d);
    }
    return buildCalendar(dayMap, weeks, tz);
  }, [data, tz, weeks]);

  const totalGames = (data?.days || []).reduce(
    (acc, d) => acc + (d.total || 0),
    0,
  );
  const totalWins = (data?.days || []).reduce(
    (acc, d) => acc + (d.wins || 0),
    0,
  );

  if (isLoading) {
    return (
      <Card title="Activity calendar">
        <Skeleton rows={3} />
      </Card>
    );
  }

  if (totalGames === 0) {
    return (
      <Card title="Activity calendar">
        <EmptyState
          title="No activity to plot"
          sub="Once you've played at least one game, the calendar will fill in."
        />
      </Card>
    );
  }

  const headline = `${totalGames} game${totalGames === 1 ? "" : "s"} · ${totalWins}W · ${
    totalGames - totalWins
  }L · ${calendar.weeks.length} weeks shown`;

  return (
    <Card title="Activity calendar">
      <p className="-mt-1 mb-3 text-caption text-text-dim">
        {headline} · cell colour = win-rate, saturation = games played.
      </p>
      <div className="overflow-x-auto pb-1">
        <div className="flex gap-2">
          <div
            className="flex flex-col text-[9px] uppercase tracking-wide text-text-dim"
            aria-hidden
          >
            {DAY_LABELS.map((label, i) => (
              <div
                key={i}
                className="flex h-3.5 items-center"
                style={{ marginBottom: 2 }}
              >
                {label}
              </div>
            ))}
          </div>
          <div className="flex">
            {calendar.weeks.map((week, wi) => (
              <div key={wi} className="flex flex-col">
                {week.map((cell, di) =>
                  cell ? (
                    <CalendarCell key={`${wi}-${di}`} cell={cell} />
                  ) : (
                    <div
                      key={`${wi}-${di}`}
                      className="h-3.5 w-3.5"
                      style={{ marginRight: 2, marginBottom: 2 }}
                      aria-hidden
                    />
                  ),
                )}
              </div>
            ))}
          </div>
        </div>
      </div>
      <Legend />
    </Card>
  );
}

function CalendarCell({ cell }: { cell: CalCell }) {
  const empty = cell.total === 0;
  const wr = empty ? 0 : cell.wins / cell.total;
  // Volume → opacity, but keep the floor high enough that a 1-game day
  // still reads as clearly tinted instead of "almost empty grey". Caps
  // at 6 games so a 50-game day doesn't dwarf its neighbours.
  const intensity = empty ? 0 : 0.55 + Math.min(1, cell.total / 6) * 0.45;
  const background = empty
    ? "rgba(31, 37, 51, 0.55)"
    : wrFill(wr, intensity);
  const tooltip = empty
    ? `${cell.date}: no games`
    : `${cell.date}: ${cell.wins}W-${cell.losses}L (${Math.round(wr * 100)}% WR)`;
  return (
    <div
      className="h-3.5 w-3.5 rounded-[3px]"
      style={{ background, marginRight: 2, marginBottom: 2 }}
      title={tooltip}
      aria-label={tooltip}
    />
  );
}

function Legend() {
  return (
    <div className="mt-2 flex flex-wrap items-center gap-2 text-[10px] text-text-dim">
      <span>Less ←</span>
      <span
        className="h-3 w-3 rounded-[3px]"
        style={{ background: "rgba(31, 37, 51, 0.55)" }}
      />
      <span
        className="h-3 w-3 rounded-[3px]"
        style={{ background: wrFill(0.25, 0.85) }}
      />
      <span
        className="h-3 w-3 rounded-[3px]"
        style={{ background: wrFill(0.5, 0.9) }}
      />
      <span
        className="h-3 w-3 rounded-[3px]"
        style={{ background: wrFill(0.7, 1) }}
      />
      <span>→ More wins</span>
    </div>
  );
}

type CalCell = {
  date: string;
  wins: number;
  losses: number;
  total: number;
};

function buildCalendar(
  dayMap: Map<string, ActivityDay>,
  weeks: number,
  tz: string,
): { weeks: Array<Array<CalCell | null>> } {
  const today = new Date();
  const todayKey = localDateKey(today, tz);
  const todayDow = mondayBasedDow(today, tz);
  // End the calendar on the user's local Sunday (or today, if it
  // hasn't reached Sunday yet — clamp to today). Start = end - weeks.
  const endOffset = 6 - todayDow;
  const endDate = new Date(today.getTime() + endOffset * MS_PER_DAY);
  const startDate = new Date(endDate.getTime() - (weeks * 7 - 1) * MS_PER_DAY);

  const out: Array<Array<CalCell | null>> = [];
  for (let w = 0; w < weeks; w++) {
    /** @type {Array<CalCell | null>} */
    const col: Array<CalCell | null> = [];
    for (let d = 0; d < 7; d++) {
      const offset = w * 7 + d;
      const cellDate = new Date(startDate.getTime() + offset * MS_PER_DAY);
      const key = localDateKey(cellDate, tz);
      // Don't paint future days.
      if (key > todayKey) {
        col.push(null);
        continue;
      }
      const entry = dayMap.get(key);
      col.push({
        date: key,
        wins: entry?.wins || 0,
        losses: entry?.losses || 0,
        total: entry?.total || 0,
      });
    }
    out.push(col);
  }
  return { weeks: out };
}

function mondayBasedDow(date: Date, timeZone: string): number {
  const fmt = new Intl.DateTimeFormat("en-US", {
    timeZone,
    weekday: "short",
  });
  const parts = fmt.format(date);
  const map: Record<string, number> = {
    Mon: 0,
    Tue: 1,
    Wed: 2,
    Thu: 3,
    Fri: 4,
    Sat: 5,
    Sun: 6,
  };
  return map[parts] ?? 0;
}

function wrFill(rate: number, intensity: number): string {
  const [r, g, b] = wrRamp(rate);
  return `rgba(${r}, ${g}, ${b}, ${intensity.toFixed(3)})`;
}
