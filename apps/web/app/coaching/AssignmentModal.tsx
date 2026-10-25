"use client";

import { Gamepad2, Target } from "lucide-react";
import { useId, useRef, useState } from "react";
import { Button } from "@/components/ui/Button";
import { Field } from "@/components/ui/Field";
import { Input } from "@/components/ui/Input";
import { Modal } from "@/components/ui/Modal";
import { Select } from "@/components/ui/Select";
import { assignmentTimeZone } from "./coachingAssignmentPreferences";
import { timeZoneOptions } from "./coachingTime";
import {
  addDays, assignmentSummary, buildSuggestionKey, cadenceNoun, calendarPeriodCount,
  defaultCalendarRange, localDateKey, validateAssignmentDraft,
  type AssignmentDraft, type BuildSuggestion, type Student,
} from "./coachingPracticeModel";

export function AssignmentModal({
  saving, draft, students, buildSuggestions, browserTimeZone, onChange, onClose, onSave,
}: {
  saving: boolean;
  draft: AssignmentDraft;
  students: Student[];
  buildSuggestions: BuildSuggestion[];
  browserTimeZone: string;
  onChange: (draft: AssignmentDraft) => void;
  onClose: () => void;
  onSave: () => void;
}) {
  const formId = useId();
  const formRef = useRef<HTMLFormElement>(null);
  const [touched, setTouched] = useState<Partial<Record<keyof AssignmentDraft, boolean>>>({});
  const [attempted, setAttempted] = useState(false);
  const errors = validateAssignmentDraft(draft, { assignableStudents: students, buildOptions: buildSuggestions });
  const errorCount = Object.keys(errors).length;
  const patch = (next: Partial<AssignmentDraft>) => onChange({ ...draft, ...next });
  const field = (name: keyof AssignmentDraft) => ({
    name,
    id: `${formId}-${name}`,
    invalid: Boolean((attempted || touched[name]) && errors[name]),
    onBlur: () => setTouched((current) => ({ ...current, [name]: true })),
  });
  const error = (name: keyof AssignmentDraft) => (attempted || touched[name] || (name === "buildSelection" && draft.unavailableBuild)) ? errors[name] : undefined;
  const focusErrors = () => {
    setAttempted(true);
    const first = Array.from(formRef.current?.elements ?? []).find((element) =>
      element instanceof HTMLElement && errors[element.getAttribute("name") as keyof AssignmentDraft]);
    if (first instanceof HTMLElement) first.focus();
  };
  const submit = () => {
    if (saving) return;
    if (errorCount) focusErrors();
    else onSave();
  };
  const defaultRangeIn = (zone: string) => {
    const today = localDateKey(new Date(), zone);
    return draft.type === "total"
      ? defaultCalendarRange(today, draft.recurrence)
      : { startsOn: today, endsOn: addDays(today, 6) };
  };
  const periodCount = draft.type === "total" && !errors.startsOn && !errors.endsOn
    ? calendarPeriodCount(draft.startsOn, draft.endsOn, draft.recurrence)
    : 1;
  const student = students.find((item) => item.id === draft.studentId);
  const summary = errorCount ? null : assignmentSummary(draft, student?.name ?? "");
  return (
    <Modal
      open onClose={onClose} title="Assign a practice plan"
      description="Progress is calculated from the player's synced replay record, never self-reported."
      size="lg" disableScrimClose={saving}
      footer={(
        <div className="flex w-full flex-wrap items-center justify-end gap-2">
          {errorCount ? (
            <Button variant="ghost" size="sm" className="mr-auto" onClick={focusErrors} disabled={saving}>
              Fix {errorCount} field{errorCount === 1 ? "" : "s"} to assign
            </Button>
          ) : null}
          <Button variant="secondary" onClick={onClose} disabled={saving}>Cancel</Button>
          <Button type="submit" form={formId} loading={saving} disabled={Boolean(errorCount)}>Assign plan</Button>
        </div>
      )}
    >
      <form ref={formRef} id={formId} noValidate className="space-y-5"
        onSubmit={(event) => { event.preventDefault(); submit(); }}
        onKeyDown={(event) => {
          if (event.key === "Enter" && event.target instanceof HTMLInputElement && errorCount) {
            event.preventDefault(); focusErrors();
          }
        }}
      >
        <Field label="Student" htmlFor={`${formId}-studentId`} error={error("studentId")} required>
          <Select {...field("studentId")} value={draft.studentId} onChange={(event) => {
            const studentId = event.target.value;
            const timeZone = assignmentTimeZone(studentId, browserTimeZone);
            setTouched({});
            patch({ studentId, timeZone, buildSelection: "manual", buildName: "",
              ...(!draft.dateRangeEdited ? defaultRangeIn(timeZone) : {}) });
          }}>
            <option value="" disabled>Choose a student…</option>
            {students.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}
          </Select>
        </Field>
        <fieldset>
          <legend className="text-caption font-bold text-text-muted">What should count?</legend>
          <div className="mt-2 grid gap-2 sm:grid-cols-2">
            <ChoiceButton active={draft.type === "build"} icon={<Target className="h-4 w-4" />}
              title="A specific build" detail="One target inside a selected date window"
              onClick={() => patch({ type: "build" })} />
            <ChoiceButton active={draft.type === "total"} icon={<Gamepad2 className="h-4 w-4" />}
              title="Total 1v1 games" detail="A repeating daily, weekly, or monthly target"
              onClick={() => patch({ type: "total", recurrence: "weekly",
                ...(!draft.totalRangeInitialized && !draft.dateRangeEdited
                  ? defaultCalendarRange(draft.startsOn, "weekly") : {}), totalRangeInitialized: true })} />
          </div>
        </fieldset>
        {draft.type === "build" ? (
          <div className="space-y-3">
            <Field label="Build" htmlFor={`${formId}-buildSelection`} error={error("buildSelection")}>
              <Select {...field("buildSelection")} value={draft.buildSelection} onChange={(event) => {
                const buildSelection = event.target.value;
                const selected = buildSuggestions.find((item) => buildSuggestionKey(item) === buildSelection);
                patch({ buildSelection, buildName: selected?.name || "", unavailableBuild: false });
              }}>
                <option value="" disabled>Choose an available build…</option>
                <option value="manual">Enter an exact detected style name…</option>
                {buildSuggestions.map((item) => (
                  <option key={buildSuggestionKey(item)} value={buildSuggestionKey(item)}>
                    {item.name} — {item.matchBy === "slug" ? "custom build" : "detected style"}
                  </option>
                ))}
              </Select>
            </Field>
            {draft.buildSelection === "manual" ? (
              <Field label="Exact detected style name" htmlFor={`${formId}-buildName`} error={error("buildName")} required>
                <Input {...field("buildName")} value={draft.buildName} onChange={(event) => patch({ buildName: event.target.value })}
                  placeholder="e.g. PvP - Phoenix Style" autoComplete="off" />
              </Field>
            ) : <p className="text-caption text-text-dim">
              {buildSuggestions.find((item) => buildSuggestionKey(item) === draft.buildSelection)?.matchBy === "slug"
                ? "Matches this exact custom-build identity, even when another build has the same display name."
                : "Matches this exact replay-engine style name."}
            </p>}
          </div>
        ) : (
          <Field label="Repeat target">
            <Select value={draft.recurrence} onChange={(event) => patch({ recurrence: event.target.value as AssignmentDraft["recurrence"] })}>
              <option value="daily">Per day</option><option value="weekly">Per week</option><option value="monthly">Per month</option>
            </Select>
          </Field>
        )}
        <div className="grid gap-4 sm:grid-cols-3">
          <Field label="Required games" htmlFor={`${formId}-requiredGames`} error={error("requiredGames")} required>
            <Input {...field("requiredGames")} type="number" inputMode="numeric" min={1} max={1000} className="tabular-nums"
              value={draft.requiredGames} onChange={(event) => patch({ requiredGames: event.target.value })} />
          </Field>
          <Field label="Starts" htmlFor={`${formId}-startsOn`} error={error("startsOn")} required>
            <Input {...field("startsOn")} type="date" value={draft.startsOn}
              onChange={(event) => patch({ startsOn: event.target.value, dateRangeEdited: true })} />
          </Field>
          <Field label="Ends" htmlFor={`${formId}-endsOn`} error={error("endsOn")} required>
            <Input {...field("endsOn")} type="date" min={draft.startsOn} value={draft.endsOn}
              onChange={(event) => patch({ endsOn: event.target.value, dateRangeEdited: true })} />
          </Field>
        </div>
        <Field label="Player's time zone" htmlFor={`${formId}-timeZone`} error={error("timeZone")}
          hint={error("timeZone") ? undefined : "Daily, weekly, and monthly boundaries follow the player's local calendar."} required>
          <Select {...field("timeZone")} aria-label="Player's time zone" value={draft.timeZone} onChange={(event) => {
            const timeZone = event.target.value;
            patch({ timeZone, ...(!draft.dateRangeEdited ? defaultRangeIn(timeZone) : {}) });
          }}>
            <option value="" disabled>Select the player&apos;s time zone…</option>
            {timeZoneOptions(draft.timeZone, [assignmentTimeZone(draft.studentId, browserTimeZone), browserTimeZone]).map((zone) => (
              <option key={zone} value={zone}>{zone.replaceAll("_", " ")}</option>
            ))}
          </Select>
        </Field>
        <div className="rounded-xl border border-border bg-bg-elevated/45 px-4 py-3 text-caption text-text-muted">
          <span className="font-bold text-text">{draft.type === "build" ? "Counts one target across the selected window"
            : `Creates ${periodCount} calendar ${cadenceNoun(draft.recurrence)} target${periodCount === 1 ? "" : "s"}`}</span>
          {draft.timeZone ? ` · Boundaries use ${draft.timeZone.replaceAll("_", " ")}.` : null}
        </div>
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Plan title (optional)">
            <Input value={draft.title} maxLength={120} onChange={(event) => patch({ title: event.target.value })} placeholder="e.g. PvP Phoenix reps" />
          </Field>
          <Field label="Note (optional)">
            <Input value={draft.note} maxLength={500} onChange={(event) => patch({ note: event.target.value })} placeholder="One cue to focus on" />
          </Field>
        </div>
        <div role="status" aria-live="polite" aria-atomic="true">
          {summary ? <p className="break-words rounded-xl border border-accent/35 bg-accent/5 p-3 text-caption text-text">{summary}</p> : null}
        </div>
      </form>
    </Modal>
  );
}

function ChoiceButton({ active, icon, title, detail, onClick }: {
  active: boolean; icon: React.ReactNode; title: string; detail: string; onClick: () => void;
}) {
  return <button type="button" aria-pressed={active} onClick={onClick} className={[
    "flex min-h-20 items-start gap-3 rounded-xl border-2 p-3 text-left transition-colors",
    "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent",
    active ? "border-accent bg-accent/10" : "border-line bg-bg hover:bg-bg-elevated",
  ].join(" ")}>
    <span className={active ? "mt-0.5 text-accent-cyan" : "mt-0.5 text-text-dim"} aria-hidden>{icon}</span>
    <span><span className="block font-display text-caption font-extrabold text-text">{title}</span>
      <span className="mt-0.5 block text-micro text-text-muted">{detail}</span></span>
  </button>;
}
