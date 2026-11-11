"use client";
import { useAuth } from "@clerk/nextjs";
import { CalendarCheck2, CalendarClock, Check, Plus } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { apiCall } from "@/lib/clientApi";
import { Button } from "@/components/ui/Button";
import { Card } from "@/components/ui/Card";
import { Field } from "@/components/ui/Field";
import { Input } from "@/components/ui/Input";
import { Modal } from "@/components/ui/Modal";
import { SaveBar } from "@/components/ui/SaveBar";
import { Select } from "@/components/ui/Select";
import { useToast } from "@/components/ui/Toast";
import { apiMessage, cloneAvailability, formatDuration, PRESET_SESSION_DURATIONS, splitSessions, timeZoneOptions, useZoneClock, windowProblems } from "./coachingTime";
import { CalendarFeedCard } from "./CalendarFeedCard";
import { BookingCard, BookingSummary, ChoiceChip, EmptySchedule, PastSessions, type HistoryState } from "./CoachingScheduleParts";
import { WeeklyHoursEditor } from "./WeeklyHoursEditor";
import type { AvailabilityDraft, Booking, CalendarPayload } from "./coachingScheduleModel";
export function CoachSchedule({
  data,
  localTimeZone,
  refresh,
  onDirtyChange,
  active,
  history,
}: {
  data: CalendarPayload;
  localTimeZone: string;
  refresh: (next?: CalendarPayload, options?: { revalidate: boolean }) => Promise<CalendarPayload | undefined>;
  onDirtyChange?: (dirty: boolean) => void;
  active: boolean;
  history?: HistoryState;
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
  const problems = windowProblems(draft.windows);
  const invalidHours = Object.keys(problems).length > 0;
  const bookingTimeZone = data.availability?.timeZone ?? localTimeZone;
  useEffect(() => { onDirtyChange?.(dirty); }, [dirty, onDirtyChange]);
  useEffect(() => () => onDirtyChange?.(false), [onDirtyChange]);
  useEffect(() => { if (!active) setCancelBooking(null); }, [active]);

  useEffect(() => {
    const stamp = data.availability?.updatedAt ?? "empty";
    if (stamp === loadedStamp.current || dirty || data.availabilityRev < loadedAvailabilityRev.current) return;
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

  const save = async () => {
    if (invalidHours || !draft.durations.length || !draft.windows.length || saving) return;
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
      setDraft(cloneAvailability(next.availability ?? initial));
      await refresh(next, { revalidate: false });
      setDirty(false);
      void refresh().catch(() => undefined);
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

  const sessions = splitSessions(data.bookings, Date.now());
  const upcoming = sessions.upcoming;
  const revert = () => {
    loadedStamp.current = data.availability?.updatedAt ?? "empty";
    loadedAvailabilityRev.current = data.availabilityRev;
    setDraft(cloneAvailability(data.availability ?? { timeZone: localTimeZone, durations: [], windows: [] }));
    setDirty(false);
  };

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
              <Field label={<span id="timezone-heading">Coaching timezone</span>} className="min-w-0 flex-1">
                <Select
                  value={draft.timeZone}
                  onChange={(event) => change((current) => ({ ...current, timeZone: event.target.value }))}
                >
                  {timeZoneOptions(draft.timeZone).map((zone) => (
                    <option key={zone} value={zone}>{zone.replaceAll("_", " ")}</option>
                  ))}
                </Select>
              </Field>
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
              <Field label="Longer or custom" htmlFor="custom-session-minutes" className="w-40" hint="Minutes, in 30-minute steps.">
              <Input
                id="custom-session-minutes"
                type="number"
                min={30}
                max={480}
                step={30}
                value={customDuration}
                onChange={(event) => setCustomDuration(Number(event.target.value))}
              />
              </Field>
              <Button size="sm" variant="secondary" iconLeft={<Plus className="h-4 w-4" />} onClick={addCustomDuration}>
                Add
              </Button>
            </div>
          </section>

          <WeeklyHoursEditor draft={draft} problems={problems} onChange={change} />
        </Card.Body>
        {!dirty ? <Card.Footer className="flex-col items-stretch sm:flex-row sm:items-center">
          <span className="mr-auto text-caption text-text-muted">
            {data.availability?.enabled ? "Availability is published." : data.availability ? "New bookings are paused." : "Nothing published yet."}
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
              draft.windows.length === 0 || invalidHours
            }
            iconLeft={<Check className="h-4 w-4" />}
            onClick={() => void save()}
          >
            {data.availability?.enabled === false ? "Resume bookings" : "Save availability"}
          </Button>
        </Card.Footer> : null}
      </Card>

      <Card className="h-fit min-w-0">
        <Card.Header>
          <div>
            <h2 className="font-display text-h4 font-extrabold text-text">Upcoming sessions</h2>
            <p className="mt-0.5 text-caption text-text-muted">Shown in {bookingTimeZone.replaceAll("_", " ")}</p>
          </div>
          <span className="rounded-full bg-accent/15 px-2.5 py-1 font-mono text-caption font-bold text-accent">
            {upcoming.length}
          </span>
        </Card.Header>
        <Card.Body className="space-y-3">
          {upcoming.length ? upcoming.map((booking, index) => (
            <BookingCard
              key={booking.id}
              booking={booking}
              primaryTimeZone={bookingTimeZone}
              showStudent
              viewer={{ role: "coach", coachName: data.coach.name }}
              digestOpen={index === 0}
              onCancel={() => setCancelBooking(booking)}
            />
          )) : (
            <EmptySchedule
              icon={<CalendarCheck2 className="h-7 w-7" />}
              title="No sessions booked"
              body="Published openings will appear here after a student books one."
            />
          )}
          <PastSessions viewer="coach" timeZone={bookingTimeZone} history={history} recent={sessions.past} />
        </Card.Body>
      </Card>

      <div className="xl:col-start-2"><CalendarFeedCard /></div>

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
        {cancelBooking ? <BookingSummary booking={cancelBooking} localTimeZone={bookingTimeZone} coachTimeZone={bookingTimeZone} /> : null}
      </Modal>
      <SaveBar visible={dirty} saving={saving} saveDisabled={!draft.durations.length || !draft.windows.length || invalidHours} onSave={() => { void save(); }} onReset={revert} saveLabel="Publish availability" resetLabel="Reset" message={invalidHours ? "Fix the highlighted hours to publish" : "Unpublished availability changes"} stackOnMobile />
    </div>
  );
}
