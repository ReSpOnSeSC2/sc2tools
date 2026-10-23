"use client";
import { CalendarCheck2, Check, UserRound } from "lucide-react";
import { formatDay, formatDuration, formatRange } from "./coachingTime";
import type { Booking } from "./coachingScheduleModel";
export function BookingCard({
  booking,
  primaryTimeZone,
  coachTimeZone,
  showStudent = false,
  onCancel,
}: {
  booking: Booking;
  primaryTimeZone: string;
  coachTimeZone?: string;
  showStudent?: boolean;
  onCancel: () => void;
}) {
  return (
    <article className="rounded-xl border border-border bg-bg-elevated/50 p-3.5">
      <div className="flex items-start gap-3">
        <div className="grid h-10 w-10 shrink-0 place-items-center rounded-full bg-accent/15 text-accent">
          {showStudent ? <UserRound className="h-5 w-5" aria-hidden /> : <CalendarCheck2 className="h-5 w-5" aria-hidden />}
        </div>
        <div className="min-w-0 flex-1">
          {showStudent ? <div className="truncate font-display text-body font-extrabold text-text">{booking.studentName}</div> : null}
          <div className="font-display text-body font-bold text-text">{formatDay(booking.startAt, primaryTimeZone)}</div>
          <div className="mt-0.5 font-mono text-caption tabular-nums text-text-muted">
            {formatRange(booking.startAt, booking.endAt, primaryTimeZone)} · {formatDuration(booking.durationMinutes)}
          </div>
          {coachTimeZone && coachTimeZone !== primaryTimeZone ? (
            <div className="mt-1 text-micro text-text-dim">
              Coach time: {formatDay(booking.startAt, coachTimeZone)}, {formatRange(booking.startAt, booking.endAt, coachTimeZone)}
            </div>
          ) : null}
        </div>
      </div>
      <button
        type="button"
        onClick={onCancel}
        className="mt-3 text-caption font-bold text-text-muted underline-offset-4 hover:text-danger hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
      >
        Cancel session
      </button>
    </article>
  );
}

export function BookingSummary({ booking, localTimeZone, coachTimeZone }: { booking: Booking; localTimeZone: string; coachTimeZone: string }) {
  return (
    <div className="space-y-3 rounded-xl border border-border bg-bg-elevated p-4">
      <SummaryRow label="Date" value={formatDay(booking.startAt, localTimeZone)} />
      <SummaryRow label="Your local time" value={`${formatRange(booking.startAt, booking.endAt, localTimeZone)} · ${localTimeZone.replaceAll("_", " ")}`} />
      {coachTimeZone !== localTimeZone ? (
        <SummaryRow label="Coach time" value={`${formatRange(booking.startAt, booking.endAt, coachTimeZone)} · ${coachTimeZone.replaceAll("_", " ")}`} />
      ) : null}
      <SummaryRow label="Length" value={formatDuration(booking.durationMinutes)} />
    </div>
  );
}

function SummaryRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-start justify-between gap-4">
      <span className="text-caption text-text-muted">{label}</span>
      <span className="text-right text-caption font-bold text-text">{value}</span>
    </div>
  );
}

export function ChoiceChip({ selected, onClick, children }: { selected: boolean; onClick: () => void; children: React.ReactNode }) {
  return (
    <button
      type="button"
      aria-pressed={selected}
      onClick={onClick}
      className={[
        "inline-flex min-h-10 items-center gap-1.5 rounded-full border-2 px-4",
        "font-display text-caption font-bold transition-colors",
        "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent",
        selected
          ? "border-accent bg-accent/15 text-accent"
          : "border-line bg-bg-surface text-text-muted hover:bg-bg-elevated hover:text-text",
      ].join(" ")}
    >
      {selected ? <Check className="h-3.5 w-3.5" aria-hidden /> : null}
      {children}
    </button>
  );
}

export function EmptySchedule({ icon, title, body }: { icon: React.ReactNode; title: string; body: string }) {
  return (
    <div className="rounded-xl border border-dashed border-border px-5 py-9 text-center">
      <div className="mx-auto grid h-12 w-12 place-items-center rounded-full bg-bg-elevated text-text-muted">{icon}</div>
      <div className="mt-3 font-display text-body font-extrabold text-text">{title}</div>
      <p className="mx-auto mt-1 max-w-md text-caption text-text-muted">{body}</p>
    </div>
  );
}

export function ScheduleSkeleton() {
  return (
    <div className="grid gap-5 xl:grid-cols-[minmax(0,1.45fr)_minmax(320px,.75fr)]" aria-label="Loading sessions">
      <div className="h-[640px] animate-pulse rounded-xl border-2 border-line bg-bg-surface" />
      <div className="h-72 animate-pulse rounded-xl border-2 border-line bg-bg-surface" />
    </div>
  );
}
