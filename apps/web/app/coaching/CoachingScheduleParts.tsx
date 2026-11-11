"use client";
import { CalendarCheck2, CalendarPlus, Check, ChevronDown, Download, UserRound } from "lucide-react";
import { Button } from "@/components/ui/Button";
import { bookingIcs, downloadIcs } from "@/lib/coaching/ics";
import { siteOrigin } from "@/lib/seo/absoluteUrl";
import { formatDay, formatDuration, formatRange, googleCalendarUrl, sessionStarted, type CalendarViewer } from "./coachingTime";
import { SessionPrepDigest } from "./SessionPrepDigest";
import type { Booking, SessionHistory } from "./coachingScheduleModel";

const TEXT_ACTION = "inline-flex min-h-10 items-center gap-1.5 text-caption font-bold text-text-muted underline-offset-4 hover:text-text hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent";

/**
 * One upcoming session: when, how long, calendar links (a Google Calendar
 * template and an .ics file, both built in the browser), the "Since last
 * session" prep digest and Cancel until it starts.
 */
export function BookingCard({
  booking,
  primaryTimeZone,
  coachTimeZone,
  showStudent = false,
  viewer,
  digestOpen = false,
  active = true,
  onCancel,
}: {
  booking: Booking;
  primaryTimeZone: string;
  coachTimeZone?: string;
  showStudent?: boolean;
  viewer: Omit<CalendarViewer, "origin">;
  digestOpen?: boolean;
  active?: boolean;
  onCancel: () => void;
}) {
  const started = sessionStarted(booking, Date.now());
  const calendar = { ...viewer, origin: siteOrigin() };
  const otherName = viewer.role === "coach" ? booking.studentName : viewer.coachName;
  const day = booking.startAt.slice(0, 10);
  return (
    <article className="rounded-xl border border-border bg-bg-elevated/50 p-3.5" aria-label={`Session ${formatDay(booking.startAt, primaryTimeZone)}${showStudent ? ` with ${booking.studentName}` : ""}`}>
      <div className="flex items-start gap-3">
        <div className="grid h-10 w-10 shrink-0 place-items-center rounded-full bg-accent/15 text-accent">
          {showStudent ? <UserRound className="h-5 w-5" aria-hidden /> : <CalendarCheck2 className="h-5 w-5" aria-hidden />}
        </div>
        <div className="min-w-0 flex-1">
          {showStudent ? <div className="truncate font-display text-body font-extrabold text-text">{booking.studentName}</div> : null}
          <div className="font-display text-body font-bold text-text">
            {formatDay(booking.startAt, primaryTimeZone)}
            {started ? <span className="ml-2 rounded-full bg-success/15 px-2 py-0.5 align-middle text-micro font-bold text-success">In progress</span> : null}
          </div>
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
      <div className="mt-2 flex flex-wrap items-center gap-x-4">
        <a href={googleCalendarUrl(booking, calendar)} target="_blank" rel="noopener noreferrer" className={TEXT_ACTION}>
          <CalendarPlus className="h-4 w-4" aria-hidden />Add to Google Calendar<span className="sr-only"> (opens in a new tab)</span>
        </a>
        <button type="button" className={TEXT_ACTION}
          onClick={() => downloadIcs(`sc2tools-session-${day}.ics`, bookingIcs(booking, `Coaching session with ${otherName}`))}>
          <Download className="h-4 w-4" aria-hidden />Download .ics
        </button>
        {started ? null : (
          <button type="button" onClick={onCancel} className={`${TEXT_ACTION} hover:text-danger`}>
            Cancel session
          </button>
        )}
      </div>
      <SessionPrepDigest bookingId={booking.id} viewerRole={viewer.role} timeZone={primaryTimeZone} studentName={booking.studentName} defaultOpen={digestOpen} active={active} />
    </article>
  );
}

/** SWR-backed past-session history handed down from CoachingSchedule. */
export type HistoryState = { data?: SessionHistory; error?: unknown; retry: () => void };

function cancelledBy(booking: Booking, role: "coach" | "student") {
  if (!booking.cancelledBy) return "Cancelled";
  if (booking.cancelledBy === role) return "Cancelled by you";
  return booking.cancelledBy === "coach" ? "Cancelled by your coach" : "Cancelled by the student";
}

/**
 * "Past sessions (n)" under Upcoming: the complete history from the API,
 * newest first, cancelled sessions marked. Until it loads (or if it
 * fails) the calendar's last 30 days stand in.
 */
export function PastSessions({ viewer: role, timeZone, history, recent }: {
  viewer: "coach" | "student";
  timeZone: string;
  history?: HistoryState;
  recent: Booking[];
}) {
  const data = history?.data && Array.isArray(history.data.bookings) ? history.data : null;
  const bookings = data ? data.bookings : recent;
  const total = data ? data.total : recent.length;
  return (
    <details className="group rounded-xl border border-border">
      <summary className="flex min-h-11 cursor-pointer list-none items-center justify-between gap-2 rounded-xl px-3 text-caption font-bold text-text focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent">
        <span>Past sessions ({total})</span>
        <ChevronDown className="h-4 w-4 text-text-muted transition-transform group-open:rotate-180 motion-reduce:transition-none" aria-hidden />
      </summary>
      <div className="space-y-3 px-3 pb-3">
        {role === "coach" && data?.students?.length ? (
          <ul aria-label="Past sessions per student" className="flex flex-wrap gap-1.5 text-caption">
            {data.students.map((student) => (
              <li key={student.studentId} className="rounded-full border border-border bg-bg-elevated px-2.5 py-1 text-text">
                {student.name} · {student.held}{student.cancelled ? ` (${student.cancelled} cancelled)` : ""}
              </li>
            ))}
          </ul>
        ) : null}
        {history?.error && !data ? (
          <div role="alert" className="flex flex-wrap items-center gap-2 text-caption text-text-muted">
            <span>Older sessions could not load. Showing the last 30 days.</span>
            <Button size="sm" variant="secondary" onClick={history.retry}>Retry</Button>
          </div>
        ) : null}
        {bookings.length ? (
          <ul className="space-y-1.5">
            {bookings.map((booking) => (
              <li key={booking.id} className="flex flex-wrap items-baseline gap-x-2 rounded-lg border border-border bg-bg-elevated/35 px-3 py-2 text-caption">
                {role === "coach" ? <span className="font-bold text-text">{booking.studentName}</span> : null}
                <span className="text-text">{formatDay(booking.startAt, timeZone)}</span>
                <span className="font-mono tabular-nums text-text-muted">{formatRange(booking.startAt, booking.endAt, timeZone)} · {formatDuration(booking.durationMinutes)}</span>
                {booking.status === "cancelled" ? (
                  <span className="rounded-full bg-danger/10 px-2 py-0.5 text-micro font-bold text-danger">{cancelledBy(booking, role)}</span>
                ) : null}
              </li>
            ))}
          </ul>
        ) : (
          <p className="text-caption text-text-dim">No past sessions yet.</p>
        )}
        {data?.hasMore ? <p className="text-micro text-text-dim">Showing the latest {data.bookings.length} of {data.total}.</p> : null}
      </div>
    </details>
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
