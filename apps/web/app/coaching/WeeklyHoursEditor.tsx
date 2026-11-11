"use client";
import { useEffect, useState } from "react";
import { MoreHorizontal, Plus, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/Button";
import { Field } from "@/components/ui/Field";
import { Input } from "@/components/ui/Input";
import { ReviewMenu, type ReviewMenuItem } from "@/components/reviews/ReviewMenu";
import { clockValue, COACHING_DAYS, compareWindows, endClockValue, endMinuteValue, minuteValue } from "./coachingTime";
import { clearDay, copyDay, copyLabel, copyTargets, nextWindow, presetsFor, replacedDays, restoreDays, UNDO_MS, type CopyScope } from "./coachingAvailability";
import type { AvailabilityDraft, AvailabilityWindow } from "./coachingScheduleModel";

type Undo = { day: number; days: number[]; previous: AvailabilityWindow[]; applied: string; message: string };
type Change = (fn: (current: AvailabilityDraft) => AvailabilityDraft) => void;

function hoursKey(windows: AvailabilityWindow[], days: number[]) {
  return windows.filter((window) => days.includes(window.day)).sort(compareWindows)
    .map(({ day, startMinute, endMinute }) => `${day}:${startMinute}-${endMinute}`).join(",");
}

/**
 * Weekly hours, one row per day: windows, a day menu (copy to weekdays,
 * copy to all days, clear) with a 10-second Undo, presets for an empty
 * day and "Add hours" after the last window.
 */
export function WeeklyHoursEditor({ draft, problems, onChange }: {
  draft: AvailabilityDraft;
  problems: Partial<Record<number, string>>;
  onChange: Change;
}) {
  const [undo, setUndo] = useState<Undo | null>(null);
  useEffect(() => {
    if (!undo) return;
    const timer = window.setTimeout(() => setUndo(null), UNDO_MS);
    return () => window.clearTimeout(timer);
  }, [undo]);
  const availableUndo = undo && hoursKey(draft.windows, undo.days) === undo.applied ? undo : null;
  const setWindows = (fn: (windows: AvailabilityWindow[]) => AvailabilityWindow[]) =>
    onChange((current) => ({ ...current, windows: fn(current.windows) }));
  const replaceDays = (day: number, days: number[], fn: (windows: AvailabilityWindow[]) => AvailabilityWindow[], message: string) => {
    const previous = draft.windows.filter((window) => days.includes(window.day)).map((window) => ({ ...window }));
    setWindows(fn);
    setUndo({ day, days, previous, applied: hoursKey(fn(draft.windows), days), message });
  };
  const runUndo = (entry: Undo) => {
    setWindows((windows) => hoursKey(windows, entry.days) === entry.applied
      ? restoreDays(windows, entry.previous, entry.days) : windows);
    setUndo(null);
  };
  const dayMenu = (day: (typeof COACHING_DAYS)[number], windows: AvailabilityWindow[]): ReviewMenuItem[] => {
    if (!windows.length) return [];
    const invalid = windows.some((window) => problems[draft.windows.indexOf(window)]);
    const copy = (scope: CopyScope): ReviewMenuItem => {
      const targets = copyTargets(day.day, scope);
      return {
        id: scope, label: copyLabel(scope, replacedDays(draft.windows, targets)), disabled: invalid,
        onSelect: () => replaceDays(day.day, targets, (current) => copyDay(current, day.day, targets),
          `Copied ${day.long}'s hours to ${scope === "weekdays" ? "the weekdays" : "every day"}.`),
      };
    };
    return [copy("weekdays"), copy("all"), {
      id: "clear", label: "Clear day",
      onSelect: () => replaceDays(day.day, [day.day], (current) => clearDay(current, day.day), `Cleared ${day.long}.`),
    }];
  };

  return (
    <section aria-labelledby="weekly-hours-heading">
      <h3 id="weekly-hours-heading" className="text-caption font-bold text-text">Weekly hours</h3>
      <p className="mt-1 text-caption text-text-muted">
        Timeclock-style recurring windows in {draft.timeZone.replaceAll("_", " ")}. Use a day&apos;s menu to copy its hours.
      </p>
      <span role="status" className="sr-only">{availableUndo ? `${availableUndo.message} Undo is available for 10 seconds.` : ""}</span>
      <div className="mt-3 divide-y divide-border overflow-hidden rounded-xl border border-border">
        {COACHING_DAYS.map((day) => {
          const windows = draft.windows.filter((window) => window.day === day.day);
          const next = nextWindow(draft.windows, day.day);
          return (
            <div key={day.day} className="grid gap-3 bg-bg-surface p-3 sm:grid-cols-[124px_1fr] sm:items-start">
              <div className="flex flex-wrap items-center justify-between gap-x-2 gap-y-1 sm:block">
                <div>
                  <div className="font-display text-caption font-bold text-text">{day.long}</div>
                  <span className="text-micro text-text-dim sm:mt-0.5 sm:block">
                    {windows.length ? `${windows.length} window${windows.length === 1 ? "" : "s"}` : "Unavailable"}
                  </span>
                </div>
                <div className="flex items-center gap-1 sm:mt-1">
                  <ReviewMenu label={`${day.long} hours actions`} items={dayMenu(day, windows)}>
                    <MoreHorizontal className="h-4 w-4" aria-hidden />
                  </ReviewMenu>
                  {availableUndo?.day === day.day ? (
                    <button type="button" onClick={() => runUndo(availableUndo)} className="min-h-10 rounded-full px-2 text-caption font-bold text-link hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent">
                      Undo<span className="sr-only">: {availableUndo.message}</span>
                    </button>
                  ) : null}
                </div>
              </div>
              <div className="space-y-2">
                {windows.map((window, index) => (
                  <WindowRow key={`${day.day}-${index}`} dayLabel={day.long} index={index} window={window}
                    problem={problems[draft.windows.indexOf(window)]} onChange={setWindows} />
                ))}
                <div className="flex flex-wrap items-center gap-2">
                  <Button
                    size="sm"
                    variant="ghost"
                    iconLeft={<Plus className="h-4 w-4" />}
                    onClick={() => { if (next) setWindows((current) => [...current, next].sort(compareWindows)); }}
                    disabled={!next}
                  >
                    {windows.length ? "Add hours" : "Set hours"}
                  </Button>
                  {windows.length ? null : presetsFor(day.day).map((preset) => (
                    <Button key={preset.id} size="sm" variant="secondary"
                      onClick={() => setWindows((current) => [...current, { day: day.day, startMinute: preset.startMinute, endMinute: preset.endMinute }].sort(compareWindows))}>
                      {preset.label}<span className="sr-only"> on {day.long}</span>
                    </Button>
                  ))}
                </div>
              </div>
            </div>
          );
        })}
      </div>
    </section>
  );
}

function WindowRow({ dayLabel, index, window, problem, onChange }: {
  dayLabel: string;
  index: number;
  window: AvailabilityWindow;
  problem: string | undefined;
  onChange: (fn: (windows: AvailabilityWindow[]) => AvailabilityWindow[]) => void;
}) {
  const update = (field: "startMinute" | "endMinute", value: number) =>
    onChange((windows) => windows.map((item) => (item === window ? { ...item, [field]: value } : item)));
  return (
    <div className="flex flex-wrap items-start gap-2">
      <Field label="Starts" error={problem} className="min-w-32 flex-1 sm:flex-none">
        <Input aria-label={`${dayLabel} start time ${index + 1}`} type="time" step={1800} value={clockValue(window.startMinute)}
          onChange={(event) => update("startMinute", minuteValue(event.target.value))} invalid={Boolean(problem)} />
      </Field>
      <Field label="Ends" error={problem} className="min-w-32 flex-1 sm:flex-none">
        <Input aria-label={`${dayLabel} end time ${index + 1}`} type="time" step={1800} value={endClockValue(window.endMinute)}
          onChange={(event) => update("endMinute", endMinuteValue(event.target.value))} invalid={Boolean(problem)} />
      </Field>
      <button
        type="button"
        aria-label={`Remove ${dayLabel} window ${index + 1}`}
        onClick={() => onChange((windows) => windows.filter((item) => item !== window))}
        className="mt-6 grid h-10 w-10 place-items-center rounded-full text-text-muted hover:bg-danger/10 hover:text-danger focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
      >
        <Trash2 className="h-4 w-4" aria-hidden />
      </button>
    </div>
  );
}
