import { CalendarDays, Clock3, History, Swords } from "lucide-react";
import { Card } from "@/components/ui/Card";
import type { CareerRecord } from "@/lib/career/careerRecord";
import { formatDate, formatDuration, formatNumber } from "@/lib/i18n/format";

const HEADING = "font-display text-h3 font-semibold text-text";
const WEEKDAY_BASE = Date.UTC(2024, 0, 7);
const DAY_MS = 86_400_000;

export function countLabel(count: number, item: string) {
  return `${formatNumber(count)} ${item}${count === 1 ? "" : "s"}`;
}

function calendarDay(day: string) {
  return formatDate(day, { month: "short", day: "numeric", year: "numeric", timeZone: "UTC" });
}

function CareerTotals({ record }: { record: CareerRecord }) {
  const { first, games, seconds, timedGames, weekdays, weekdayGames } = record;
  return (
    <div className="grid gap-3 md:grid-cols-3">
      <Card>
        <dl className="space-y-2">
        <dt className="flex items-center gap-2 text-body font-semibold text-text-muted"><CalendarDays aria-hidden className="size-4" /> First replay found</dt>
        <dd className={HEADING}>{calendarDay(first.day)}</dd>
        <dd className="break-words text-caption text-text-muted">{first.map ?? "Map unknown"}</dd>
        </dl>
      </Card>
      <Card>
        <dl className="space-y-2">
        <dt className="flex items-center gap-2 text-body font-semibold text-text-muted"><Clock3 aria-hidden className="size-4" /> Recorded time</dt>
        <dd className={HEADING}>{timedGames ? formatDuration(seconds, "short") : "Unavailable"}</dd>
        <dd className="text-caption text-text-muted">{formatNumber(timedGames)} of {countLabel(games, "game")} with a duration</dd>
        </dl>
      </Card>
      <Card>
        <dl className="space-y-2">
        <dt className="flex items-center gap-2 text-body font-semibold text-text-muted"><Swords aria-hidden className="size-4" /> Busiest match days</dt>
        <dd className="font-display text-body font-semibold text-text">{weekdays.map((day) =>
          formatDate(WEEKDAY_BASE + day * DAY_MS, { weekday: "long", timeZone: "UTC" })).join(", ")}</dd>
        <dd className="text-caption text-text-muted">{countLabel(weekdayGames, "game")}{weekdays.length > 1 ? " each" : ""} (UTC)</dd>
        </dl>
      </Card>
    </div>
  );
}

function CareerYears({ years }: { years: CareerRecord["years"] }) {
  return (
    <section aria-labelledby="career-years" className="space-y-3">
      <h3 id="career-years" className={HEADING}>Your race journey</h3>
      <ul className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
        {years.map(({ year, games, map, mapGames, races }) => (
          <li key={year} className="min-w-0">
            <Card padded={false} className="h-full space-y-3 p-4">
              <div className="flex flex-wrap items-baseline justify-between gap-2">
                <h4 className="font-display text-h3 font-semibold text-text">{year}</h4>
                <p className="text-caption text-text-muted">{countLabel(games, "game")}</p>
              </div>
              <p className="break-words text-body text-text">
                {map ? <>Most played map <span className="font-semibold">{map}</span> <span className="text-text-muted">({countLabel(mapGames, "game")})</span></> : "No map recorded"}
              </p>
              <ul aria-label={`Race totals for ${year}`} className="flex flex-wrap gap-2">
                {races.map(({ race, games }) => <li key={race} className="rounded-md border border-line px-2 py-1 text-caption text-text">{race} · {formatNumber(games)}</li>)}
              </ul>
            </Card>
          </li>
        ))}
      </ul>
    </section>
  );
}

function CareerTimeline({ eras, gaps }: Pick<CareerRecord, "eras" | "gaps">) {
  return (
    <div className="grid gap-3 md:grid-cols-2">
      <Card padded={false} aria-labelledby="career-eras" className="space-y-3 p-4">
        <h3 id="career-eras" className={HEADING}>Expansion eras</h3>
        <ul className="divide-y divide-line">
          {eras.map(({ era, firstDay, lastDay, games }) => (
            <li key={era} className="space-y-1 py-2">
              <p className="text-body font-semibold text-text">{era === "Unknown" ? "Unknown expansion" : era}</p>
              <p className="text-caption text-text-muted">
                {calendarDay(firstDay)}{lastDay === firstDay ? "" : ` to ${calendarDay(lastDay)}`} · {countLabel(games, "game")}
              </p>
            </li>
          ))}
        </ul>
      </Card>
      <Card padded={false} aria-labelledby="career-gaps" className="space-y-3 p-4">
        <h3 id="career-gaps" className={`flex items-center gap-2 ${HEADING}`}><History aria-hidden className="size-5" /> Gaps in the record</h3>
        <p className="text-caption text-text-muted">A gap of at least 90 days between replays in this selection.</p>
        {gaps.length ? <ul className="divide-y divide-line">{gaps.map(({ days, after, before }) => (
          <li key={after} className="space-y-1 py-2">
            <p className="text-body font-semibold text-text">{countLabel(days, "day")}</p>
            <p className="text-caption text-text-muted">{calendarDay(after)} to {calendarDay(before)}</p>
          </li>
        ))}</ul> : <p className="text-body text-text-muted">No gaps of 90 days or more.</p>}
      </Card>
    </div>
  );
}

export function CareerChapters({ record }: { record: CareerRecord }) {
  return <>
    <CareerTotals record={record} />
    <CareerYears years={record.years} />
    <CareerTimeline eras={record.eras} gaps={record.gaps} />
  </>;
}
