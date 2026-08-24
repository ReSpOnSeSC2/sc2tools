"use client";

import { useAuth } from "@clerk/nextjs";
import {
  CalendarCheck2,
  CalendarClock,
  Check,
  Clock3,
  Globe2,
  Plus,
  Trash2,
  UserRound,
} from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { apiCall, useApi } from "@/lib/clientApi";
import { Button } from "@/components/ui/Button";
import { Card } from "@/components/ui/Card";
import { Modal } from "@/components/ui/Modal";
import { useToast } from "@/components/ui/Toast";
import {
  apiMessage,
  cloneAvailability,
  clockValue,
  COACHING_DAYS,
  compareWindows,
  fieldClass,
  formatDay,
  formatDuration,
  formatRange,
  formatTime,
  groupSlots,
  minuteValue,
  PRESET_SESSION_DURATIONS,
  timeZoneOptions,
  useLocalTimeZone,
  useZoneClock,
} from "./coachingTime";

type AvailabilityWindow = {
  day: number;
  startMinute: number;
  endMinute: number;
};

type Availability = {
  enabled: boolean;
  timeZone: string;
  durations: number[];
  windows: AvailabilityWindow[];
  updatedAt: string | null;
};

type Booking = {
  id: string;
  studentName: string;
  startAt: string;
  endAt: string;
  durationMinutes: number;
  status: "booked" | "cancelled";
  cancelledBy: "coach" | "student" | null;
  createdAt: string;
};

type Slot = {
  startAt: string;
  endAt: string;
  durationMinutes: number;
};

type CalendarPayload = {
  role: "coach" | "student";
  coach: { id: string; name: string };
  viewerTimeZone: string;
  availabilityRev: number;
  availability: Availability | null;
  bookings: Booking[];
  unreadAlerts: Array<{ bookingId: string; updatedAt: string }>;
  slots: Slot[];
};

type AvailabilityDraft = {
  timeZone: string;
  durations: number[];
  windows: AvailabilityWindow[];
};

export default function CoachingSchedule() {
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
  }, [calendar.data, getToken]);

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
    />
  ) : (
    <StudentSchedule
      data={calendar.data}
      localTimeZone={localTimeZone}
      refresh={calendar.mutate}
    />
  );
}

function CoachSchedule({
  data,
  localTimeZone,
  refresh,
}: {
  data: CalendarPayload;
  localTimeZone: string;
  refresh: () => Promise<CalendarPayload | undefined>;
}) {
  const { getToken } = useAuth();
  const { toast } = useToast();
  const initial = data.availability ?? {
    timeZone: localTimeZone,
    durations: [],
    windows: [],
  };
  const [draft, setDraft] = useState<AvailabilityDraft>(() => cloneAvailability(initial));
  const [dirty, setDirty] = useState(false);
  const [saving, setSaving] = useState(false);
  const [pausing, setPausing] = useState(false);
  const [customDuration, setCustomDuration] = useState(180);
  const [cancelBooking, setCancelBooking] = useState<Booking | null>(null);
  const [cancelling, setCancelling] = useState(false);
  const loadedStamp = useRef(data.availability?.updatedAt ?? "empty");
  const loadedAvailabilityRev = useRef(data.availabilityRev);
  const clock = useZoneClock(draft.timeZone);

  useEffect(() => {
    const stamp = data.availability?.updatedAt ?? "empty";
    if (stamp === loadedStamp.current || dirty) return;
    loadedStamp.current = stamp;
    loadedAvailabilityRev.current = data.availabilityRev;
    setDraft(cloneAvailability(data.availability ?? {
      timeZone: localTimeZone,
      durations: [],
      windows: [],
    }));
  }, [data.availability, data.availabilityRev, dirty, localTimeZone]);

  const change = (fn: (current: AvailabilityDraft) => AvailabilityDraft) => {
    setDraft((current) => fn(current));
    setDirty(true);
  };

  const toggleDuration = (minutes: number) => {
    change((current) => ({
      ...current,
      durations: current.durations.includes(minutes)
        ? current.durations.filter((item) => item !== minutes)
        : [...current.durations, minutes].sort((a, b) => a - b),
    }));
  };

  const addCustomDuration = () => {
    const minutes = Math.round(customDuration / 30) * 30;
    if (minutes < 30 || minutes > 480) {
      toast.error("Use a session length between 30 minutes and 8 hours.");
      return;
    }
    if (!draft.durations.includes(minutes)) toggleDuration(minutes);
  };

  const addWindow = (day: number) => {
    change((current) => ({
      ...current,
      windows: [...current.windows, { day, startMinute: 9 * 60, endMinute: 17 * 60 }]
        .sort(compareWindows),
    }));
  };

  const updateWindow = (
    target: AvailabilityWindow,
    field: "startMinute" | "endMinute",
    value: number,
  ) => {
    change((current) => ({
      ...current,
      windows: current.windows.map((window) =>
        window === target ? { ...window, [field]: value } : window,
      ).sort(compareWindows),
    }));
  };

  const removeWindow = (target: AvailabilityWindow) => {
    change((current) => ({
      ...current,
      windows: current.windows.filter((window) => window !== target),
    }));
  };

  const save = async () => {
    setSaving(true);
    try {
      const next = await apiCall<CalendarPayload>(
        getToken,
        "/v1/coaching/calendar/availability",
        {
          method: "PUT",
          body: JSON.stringify({ ...draft, expectedRev: loadedAvailabilityRev.current }),
        },
      );
      loadedStamp.current = next.availability?.updatedAt ?? "empty";
      loadedAvailabilityRev.current = next.availabilityRev;
      setDirty(false);
      await refresh();
      toast.success("Availability published", {
        description: "Students now see these openings in their own local time.",
      });
    } catch (error) {
      toast.error("Availability was not saved", {
        description: apiMessage(error),
      });
    } finally {
      setSaving(false);
    }
  };

  const pause = async () => {
    setPausing(true);
    try {
      await apiCall<CalendarPayload>(
        getToken,
        "/v1/coaching/calendar/availability",
        {
          method: "DELETE",
          body: JSON.stringify({ expectedRev: loadedAvailabilityRev.current }),
        },
      );
      setDirty(false);
      await refresh();
      toast.success("New bookings paused", {
        description: "Existing sessions stay booked. Save availability again when you are ready to reopen.",
      });
    } catch (error) {
      await refresh();
      toast.error("Booking was not paused", { description: apiMessage(error) });
    } finally {
      setPausing(false);
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
        description: "The student will see the update in Coaching.",
      });
    } catch (error) {
      await refresh();
      toast.error("Session was not cancelled", { description: apiMessage(error) });
    } finally {
      setCancelling(false);
    }
  };

  const upcoming = data.bookings.filter(
    (booking) => booking.status === "booked" && new Date(booking.startAt).getTime() > Date.now(),
  );

  return (
    <div className="grid gap-5 xl:grid-cols-[minmax(0,1.45fr)_minmax(320px,.75fr)]">
      <Card className="min-w-0">
        <Card.Header className="items-start">
          <div>
            <p className="text-micro font-bold uppercase tracking-[0.16em] text-accent-cyan">
              Coach schedule
            </p>
            <h2 className="mt-1 font-display text-h3 font-extrabold text-text">
              Availability
            </h2>
            <p className="mt-1 text-caption text-text-muted">
              Publish recurring hours once. Booked sessions stay booked if you edit them later.
            </p>
          </div>
          <CalendarClock className="h-6 w-6 shrink-0 text-accent" aria-hidden />
        </Card.Header>
        <Card.Body className="space-y-7 p-4 sm:p-5">
          <section aria-labelledby="timezone-heading">
            <div className="flex flex-wrap items-end gap-3">
              <label className="min-w-0 flex-1">
                <span id="timezone-heading" className="text-caption font-bold text-text">
                  Coaching timezone
                </span>
                <select
                  value={draft.timeZone}
                  onChange={(event) => change((current) => ({ ...current, timeZone: event.target.value }))}
                  className={fieldClass("mt-2 w-full")}
                >
                  {timeZoneOptions(draft.timeZone).map((zone) => (
                    <option key={zone} value={zone}>{zone.replaceAll("_", " ")}</option>
                  ))}
                </select>
              </label>
              <div className="rounded-lg border border-border bg-bg-elevated px-3 py-2.5 text-right">
                <div className="text-micro uppercase tracking-wider text-text-dim">Local time</div>
                <div className="font-mono text-caption font-semibold tabular-nums text-text">{clock}</div>
              </div>
            </div>
            {draft.timeZone !== localTimeZone ? (
              <p className="mt-2 text-caption text-warning">
                Your browser is in {localTimeZone}; availability will be published in {draft.timeZone}.
              </p>
            ) : null}
          </section>

          <section aria-labelledby="duration-heading">
            <h3 id="duration-heading" className="text-caption font-bold text-text">
              Session lengths
            </h3>
            <p className="mt-1 text-caption text-text-muted">
              Students choose from every selected duration that fits an open window.
            </p>
            <div className="mt-3 flex flex-wrap gap-2">
              {PRESET_SESSION_DURATIONS.map((minutes) => (
                <ChoiceChip
                  key={minutes}
                  selected={draft.durations.includes(minutes)}
                  onClick={() => toggleDuration(minutes)}
                >
                  {formatDuration(minutes)}
                </ChoiceChip>
              ))}
              {draft.durations
                .filter((minutes) => !PRESET_SESSION_DURATIONS.includes(minutes as 30 | 60 | 120))
                .map((minutes) => (
                  <ChoiceChip key={minutes} selected onClick={() => toggleDuration(minutes)}>
                    {formatDuration(minutes)}
                  </ChoiceChip>
                ))}
            </div>
            <div className="mt-3 flex flex-wrap items-center gap-2">
              <label className="text-caption text-text-muted" htmlFor="custom-session-minutes">
                Longer or custom
              </label>
              <input
                id="custom-session-minutes"
                type="number"
                min={30}
                max={480}
                step={30}
                value={customDuration}
                onChange={(event) => setCustomDuration(Number(event.target.value))}
                className={fieldClass("w-24")}
              />
              <span className="text-caption text-text-muted">minutes</span>
              <Button size="sm" variant="secondary" iconLeft={<Plus className="h-4 w-4" />} onClick={addCustomDuration}>
                Add
              </Button>
            </div>
          </section>

          <section aria-labelledby="weekly-hours-heading">
            <div className="flex items-end justify-between gap-3">
              <div>
                <h3 id="weekly-hours-heading" className="text-caption font-bold text-text">
                  Weekly hours
                </h3>
                <p className="mt-1 text-caption text-text-muted">
                  Timeclock-style recurring windows in {draft.timeZone.replaceAll("_", " ")}.
                </p>
              </div>
            </div>
            <div className="mt-3 divide-y divide-border overflow-hidden rounded-xl border border-border">
              {COACHING_DAYS.map((day) => {
                const windows = draft.windows.filter((window) => window.day === day.day);
                return (
                  <div key={day.day} className="grid gap-3 bg-bg-surface p-3 sm:grid-cols-[92px_1fr] sm:items-start">
                    <div className="flex items-center justify-between gap-2 sm:block">
                      <div className="font-display text-caption font-bold text-text">{day.long}</div>
                      <span className="text-micro text-text-dim sm:mt-0.5 sm:block">
                        {windows.length ? `${windows.length} window${windows.length === 1 ? "" : "s"}` : "Unavailable"}
                      </span>
                    </div>
                    <div className="space-y-2">
                      {windows.map((window, index) => (
                        <div key={`${day.day}-${index}-${window.startMinute}`} className="flex flex-wrap items-center gap-2">
                          <input
                            aria-label={`${day.long} start time ${index + 1}`}
                            type="time"
                            step={1800}
                            value={clockValue(window.startMinute)}
                            onChange={(event) => updateWindow(window, "startMinute", minuteValue(event.target.value))}
                            className={fieldClass("min-w-32 flex-1 sm:flex-none")}
                          />
                          <span className="text-caption text-text-dim">to</span>
                          <input
                            aria-label={`${day.long} end time ${index + 1}`}
                            type="time"
                            step={1800}
                            value={clockValue(window.endMinute)}
                            onChange={(event) => updateWindow(window, "endMinute", minuteValue(event.target.value))}
                            className={fieldClass("min-w-32 flex-1 sm:flex-none")}
                          />
                          <button
                            type="button"
                            aria-label={`Remove ${day.long} window ${index + 1}`}
                            onClick={() => removeWindow(window)}
                            className="grid h-10 w-10 place-items-center rounded-full text-text-muted hover:bg-danger/10 hover:text-danger focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
                          >
                            <Trash2 className="h-4 w-4" aria-hidden />
                          </button>
                        </div>
                      ))}
                      <Button
                        size="sm"
                        variant="ghost"
                        iconLeft={<Plus className="h-4 w-4" />}
                        onClick={() => addWindow(day.day)}
                        disabled={windows.length >= 6}
                      >
                        {windows.length ? "Add hours" : "Set hours"}
                      </Button>
                    </div>
                  </div>
                );
              })}
            </div>
          </section>
        </Card.Body>
        <Card.Footer className="flex-col items-stretch sm:flex-row sm:items-center">
          <span className="mr-auto text-caption text-text-muted">
            {dirty ? "You have unpublished changes." : data.availability?.enabled ? "Availability is published." : data.availability ? "New bookings are paused." : "Nothing published yet."}
          </span>
          {data.availability?.enabled ? (
            <Button variant="ghost" loading={pausing} disabled={saving} onClick={() => void pause()}>
              Pause new bookings
            </Button>
          ) : null}
          <Button
            loading={saving}
            disabled={
              (data.availability?.enabled !== false && !dirty) ||
              draft.durations.length === 0 ||
              draft.windows.length === 0
            }
            iconLeft={<Check className="h-4 w-4" />}
            onClick={() => void save()}
          >
            {data.availability?.enabled === false ? "Resume bookings" : "Save availability"}
          </Button>
        </Card.Footer>
      </Card>

      <Card className="h-fit min-w-0">
        <Card.Header>
          <div>
            <h2 className="font-display text-h4 font-extrabold text-text">Upcoming sessions</h2>
            <p className="mt-0.5 text-caption text-text-muted">Shown in {draft.timeZone.replaceAll("_", " ")}</p>
          </div>
          <span className="rounded-full bg-accent/15 px-2.5 py-1 font-mono text-caption font-bold text-accent">
            {upcoming.length}
          </span>
        </Card.Header>
        <Card.Body className="space-y-3">
          {upcoming.length ? upcoming.map((booking) => (
            <BookingCard
              key={booking.id}
              booking={booking}
              primaryTimeZone={draft.timeZone}
              showStudent
              onCancel={() => setCancelBooking(booking)}
            />
          )) : (
            <EmptySchedule
              icon={<CalendarCheck2 className="h-7 w-7" />}
              title="No sessions booked"
              body="Published openings will appear here after a student books one."
            />
          )}
        </Card.Body>
      </Card>

      <Modal
        open={Boolean(cancelBooking)}
        onClose={() => !cancelling && setCancelBooking(null)}
        title="Cancel this session?"
        description="The opening becomes available to students again."
        footer={(
          <>
            <Button variant="ghost" onClick={() => setCancelBooking(null)} disabled={cancelling}>Keep session</Button>
            <Button variant="danger" loading={cancelling} onClick={() => void confirmCancel()}>Cancel session</Button>
          </>
        )}
      >
        {cancelBooking ? <BookingSummary booking={cancelBooking} localTimeZone={draft.timeZone} coachTimeZone={draft.timeZone} /> : null}
      </Modal>
    </div>
  );
}

function StudentSchedule({
  data,
  localTimeZone,
  refresh,
}: {
  data: CalendarPayload;
  localTimeZone: string;
  refresh: () => Promise<CalendarPayload | undefined>;
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

function BookingCard({
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

function BookingSummary({ booking, localTimeZone, coachTimeZone }: { booking: Booking; localTimeZone: string; coachTimeZone: string }) {
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

function ChoiceChip({ selected, onClick, children }: { selected: boolean; onClick: () => void; children: React.ReactNode }) {
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

function EmptySchedule({ icon, title, body }: { icon: React.ReactNode; title: string; body: string }) {
  return (
    <div className="rounded-xl border border-dashed border-border px-5 py-9 text-center">
      <div className="mx-auto grid h-12 w-12 place-items-center rounded-full bg-bg-elevated text-text-muted">{icon}</div>
      <div className="mt-3 font-display text-body font-extrabold text-text">{title}</div>
      <p className="mx-auto mt-1 max-w-md text-caption text-text-muted">{body}</p>
    </div>
  );
}

function ScheduleSkeleton() {
  return (
    <div className="grid gap-5 xl:grid-cols-[minmax(0,1.45fr)_minmax(320px,.75fr)]" aria-label="Loading sessions">
      <div className="h-[640px] animate-pulse rounded-xl border-2 border-line bg-bg-surface" />
      <div className="h-72 animate-pulse rounded-xl border-2 border-line bg-bg-surface" />
    </div>
  );
}
