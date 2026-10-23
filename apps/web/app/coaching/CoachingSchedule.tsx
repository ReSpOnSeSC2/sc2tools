"use client";
import { useAuth } from "@clerk/nextjs";
import { CalendarCheck2, CalendarClock, Clock3, Globe2 } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { apiCall, useApi } from "@/lib/clientApi";
import { Button } from "@/components/ui/Button";
import { Card } from "@/components/ui/Card";
import { Modal } from "@/components/ui/Modal";
import { useToast } from "@/components/ui/Toast";
import { apiMessage, fieldClass, formatDay, formatDuration, formatTime, groupSlots, useLocalTimeZone, useZoneClock } from "./coachingTime";
import { CoachSchedule } from "./CoachSchedule";
import { BookingCard, BookingSummary, ChoiceChip, EmptySchedule, ScheduleSkeleton } from "./CoachingScheduleParts";
import type { Booking, CalendarPayload, Slot } from "./coachingScheduleModel";
export default function CoachingSchedule({ onDirtyChange, active = true }: { onDirtyChange?: (dirty: boolean) => void; active?: boolean }) {
  const localTimeZone = useLocalTimeZone();
  const path = `/v1/coaching/calendar?timeZone=${encodeURIComponent(localTimeZone)}`;
  const calendar = useApi<CalendarPayload>(path, {
    revalidateOnFocus: true,
    refreshInterval: 60_000,
  });
  const mutateCalendar = calendar.mutate;
  const { getToken } = useAuth();
  const readSignature = useRef("");

  useEffect(() => {
    if (!active) return;
    const alerts = calendar.data?.unreadAlerts || [];
    if (alerts.length === 0) {
      readSignature.current = "";
      return;
    }
    const signature = alerts
      .map((alert) => `${alert.bookingId}:${alert.updatedAt}`)
      .join("|");
    if (readSignature.current === signature) return;
    readSignature.current = signature;
    void apiCall(getToken, "/v1/coaching/alerts/read", {
      method: "POST",
      body: JSON.stringify({ alerts }),
    })
      .then(() => window.dispatchEvent(new Event("coaching:alerts-read")))
      .catch(() => {
        readSignature.current = "";
      });
  }, [calendar.data, getToken, active]);

  useEffect(() => {
    const refresh = () => void mutateCalendar();
    window.addEventListener("coaching:booking-realtime", refresh);
    return () => window.removeEventListener("coaching:booking-realtime", refresh);
  }, [mutateCalendar]);

  if (calendar.isLoading || !calendar.data) {
    if (calendar.error) {
      return (
        <Card>
          <div className="py-10 text-center">
            <h2 className="font-display text-h4 font-extrabold text-text">
              Sessions could not load
            </h2>
            <p className="mt-2 text-body text-text-muted">
              {calendar.error.message}
            </p>
            <Button className="mt-5" onClick={() => void calendar.mutate()}>
              Try again
            </Button>
          </div>
        </Card>
      );
    }
    return <ScheduleSkeleton />;
  }

  return calendar.data.role === "coach" ? (
    <CoachSchedule
      data={calendar.data}
      localTimeZone={localTimeZone}
      refresh={calendar.mutate}
      onDirtyChange={onDirtyChange}
      active={active}
    />
  ) : (
    <StudentSchedule
      data={calendar.data}
      localTimeZone={localTimeZone}
      refresh={calendar.mutate}
      active={active}
    />
  );
}

function StudentSchedule({
  data,
  localTimeZone,
  refresh,
  active,
}: {
  data: CalendarPayload;
  localTimeZone: string;
  refresh: () => Promise<CalendarPayload | undefined>;
  active: boolean;
}) {
  const { getToken } = useAuth();
  const { toast } = useToast();
  const [duration, setDuration] = useState<number | null>(data.availability?.durations[0] ?? null);
  const [selected, setSelected] = useState<Slot | null>(null);
  const [booking, setBooking] = useState(false);
  const [cancelBooking, setCancelBooking] = useState<Booking | null>(null);
  const [cancelling, setCancelling] = useState(false);
  const [showAll, setShowAll] = useState(false);
  const clock = useZoneClock(localTimeZone);
  useEffect(() => { if (!active) { setSelected(null); setCancelBooking(null); } }, [active]);

  useEffect(() => {
    const durations = data.availability?.durations || [];
    if (durations.length === 0) setDuration(null);
    else if (duration == null || !durations.includes(duration)) setDuration(durations[0]);
  }, [data.availability, duration]);

  const slots = data.slots.filter((slot) => slot.durationMinutes === duration);
  const grouped = groupSlots(slots, localTimeZone);
  const shownGroups = showAll ? grouped : grouped.slice(0, 7);
  const upcoming = data.bookings.filter(
    (item) => item.status === "booked" && new Date(item.startAt).getTime() > Date.now(),
  );

  const confirmBooking = async () => {
    if (!selected) return;
    setBooking(true);
    try {
      await apiCall(
        getToken,
        "/v1/coaching/calendar/bookings",
        {
          method: "POST",
          body: JSON.stringify({
            startAt: selected.startAt,
            durationMinutes: selected.durationMinutes,
          }),
        },
      );
      setSelected(null);
      await refresh();
      toast.success("Session booked", {
        description: `${data.coach.name} has been notified in SC2 Tools.`,
      });
    } catch (error) {
      await refresh();
      toast.error("That session was not booked", { description: apiMessage(error) });
    } finally {
      setBooking(false);
    }
  };

  const confirmCancel = async () => {
    if (!cancelBooking) return;
    setCancelling(true);
    try {
      await apiCall(
        getToken,
        `/v1/coaching/calendar/bookings/${encodeURIComponent(cancelBooking.id)}/cancel`,
        { method: "POST" },
      );
      setCancelBooking(null);
      await refresh();
      toast.success("Session cancelled", {
        description: `${data.coach.name} has been notified.`,
      });
    } catch (error) {
      await refresh();
      toast.error("Session was not cancelled", { description: apiMessage(error) });
    } finally {
      setCancelling(false);
    }
  };

  return (
    <div className="space-y-5">
      <Card variant="feature">
        <Card.Body className="flex flex-col gap-4 p-5 sm:flex-row sm:items-center sm:justify-between">
          <div>
            <p className="text-micro font-bold uppercase tracking-[0.16em] text-accent-cyan">Book with {data.coach.name}</p>
            <h2 className="mt-1 font-display text-h3 font-extrabold text-text">Choose a session</h2>
            <p className="mt-1 text-body text-text-muted">
              Every opening below is converted to your local time automatically.
            </p>
          </div>
          <div className="rounded-xl border border-border bg-bg-elevated px-4 py-3 sm:text-right">
            <div className="flex items-center gap-2 text-caption font-bold text-text sm:justify-end">
              <Globe2 className="h-4 w-4 text-accent-cyan" aria-hidden />
              Your local time
            </div>
            <div className="mt-1 font-mono text-caption tabular-nums text-text-muted">{localTimeZone.replaceAll("_", " ")} · {clock}</div>
          </div>
        </Card.Body>
      </Card>

      {upcoming.length ? (
        <Card>
          <Card.Header>
            <h2 className="font-display text-h4 font-extrabold text-text">Your upcoming sessions</h2>
            <span className="rounded-full bg-success/15 px-2.5 py-1 font-mono text-caption font-bold text-success">{upcoming.length}</span>
          </Card.Header>
          <Card.Body className="grid gap-3 lg:grid-cols-2">
            {upcoming.map((item) => (
              <BookingCard
                key={item.id}
                booking={item}
                primaryTimeZone={localTimeZone}
                coachTimeZone={data.availability?.timeZone}
                onCancel={() => setCancelBooking(item)}
              />
            ))}
          </Card.Body>
        </Card>
      ) : null}

      <Card>
        <Card.Header className="items-start">
          <div>
            <h2 className="font-display text-h4 font-extrabold text-text">Available times</h2>
            <p className="mt-1 text-caption text-text-muted">
              Displayed in {localTimeZone.replaceAll("_", " ")}.
              {data.availability?.timeZone && data.availability.timeZone !== localTimeZone
                ? ` Your coach publishes in ${data.availability.timeZone.replaceAll("_", " ")}.`
                : ""}
            </p>
          </div>
          <Clock3 className="h-5 w-5 shrink-0 text-accent" aria-hidden />
        </Card.Header>
        <Card.Body className="space-y-5">
          {!data.availability || !data.availability.enabled ? (
            <EmptySchedule
              icon={<CalendarClock className="h-7 w-7" />}
              title={data.availability ? "Booking is paused" : "No availability published yet"}
              body={data.availability
                ? `${data.coach.name} is not accepting new session bookings right now. Existing sessions are unchanged.`
                : `${data.coach.name} has not opened booking hours. Check back after they publish a schedule.`}
            />
          ) : (
            <>
              <div>
                <div className="text-caption font-bold text-text">Session length</div>
                <div className="mt-2 flex flex-wrap gap-2">
                  {data.availability.durations.map((minutes) => (
                    <ChoiceChip key={minutes} selected={duration === minutes} onClick={() => setDuration(minutes)}>
                      {formatDuration(minutes)}
                    </ChoiceChip>
                  ))}
                </div>
              </div>

              {shownGroups.length ? (
                <div className="space-y-4">
                  {shownGroups.map((group) => (
                    <section key={group.key} aria-labelledby={`slots-${group.key}`}>
                      <div className="flex items-baseline justify-between gap-3">
                        <h3 id={`slots-${group.key}`} className="font-display text-body font-extrabold text-text">{group.label}</h3>
                        <span className="text-micro text-text-dim">{group.slots.length} opening{group.slots.length === 1 ? "" : "s"}</span>
                      </div>
                      <div className="mt-2 grid grid-cols-2 gap-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-6">
                        {group.slots.map((slot) => (
                          <button
                            key={`${slot.startAt}-${slot.durationMinutes}`}
                            type="button"
                            onClick={() => setSelected(slot)}
                            className="hard-press min-h-11 rounded-full border-2 border-line bg-bg-surface px-3 font-mono text-caption font-bold tabular-nums text-text hover:border-accent hover:bg-accent/10 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
                          >
                            {formatTime(slot.startAt, localTimeZone)}
                          </button>
                        ))}
                      </div>
                    </section>
                  ))}
                  {!showAll && grouped.length > shownGroups.length ? (
                    <Button variant="secondary" onClick={() => setShowAll(true)}>Show later dates</Button>
                  ) : null}
                </div>
              ) : (
                <EmptySchedule
                  icon={<CalendarClock className="h-7 w-7" />}
                  title="No open times for this length"
                  body="Try another session length or check back after your coach updates their hours."
                />
              )}
            </>
          )}
        </Card.Body>
      </Card>

      <Modal
        open={Boolean(selected)}
        onClose={() => !booking && setSelected(null)}
        title="Confirm your session"
        description={`Book this time with ${data.coach.name}?`}
        footer={(
          <>
            <Button variant="ghost" disabled={booking} onClick={() => setSelected(null)}>Back</Button>
            <Button loading={booking} iconLeft={<CalendarCheck2 className="h-4 w-4" />} onClick={() => void confirmBooking()}>Confirm booking</Button>
          </>
        )}
      >
        {selected ? (
          <BookingSummary
            booking={{
              id: "selected",
              studentName: "",
              startAt: selected.startAt,
              endAt: selected.endAt,
              durationMinutes: selected.durationMinutes,
              status: "booked",
              cancelledBy: null,
              createdAt: selected.startAt,
            }}
            localTimeZone={localTimeZone}
            coachTimeZone={data.availability?.timeZone ?? localTimeZone}
          />
        ) : null}
      </Modal>

      <Modal
        open={Boolean(cancelBooking)}
        onClose={() => !cancelling && setCancelBooking(null)}
        title="Cancel this session?"
        description={`${data.coach.name} will be notified and the time will reopen.`}
        footer={(
          <>
            <Button variant="ghost" disabled={cancelling} onClick={() => setCancelBooking(null)}>Keep session</Button>
            <Button variant="danger" loading={cancelling} onClick={() => void confirmCancel()}>Cancel session</Button>
          </>
        )}
      >
        {cancelBooking ? <BookingSummary booking={cancelBooking} localTimeZone={localTimeZone} coachTimeZone={data.availability?.timeZone ?? localTimeZone} /> : null}
      </Modal>
    </div>
  );
}
