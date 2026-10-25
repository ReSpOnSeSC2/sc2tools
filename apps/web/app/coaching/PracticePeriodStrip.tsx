"use client";
import { completedPeriodStreak } from "./coachingPracticeProgress";
import { cadenceNoun, formatWindow, type PracticeAssignment } from "./coachingPracticeModel";

export function PracticePeriodStrip({ assignment, now, selected, onSelect }: { assignment: PracticeAssignment; now: number; selected?: string; onSelect: (key: string) => void }) {
  const { buckets } = assignment.progress;
  const zone = assignment.requirement.timeZone;
  const streak = completedPeriodStreak(buckets, now);
  return <div className="mt-3 space-y-2">
    <div className="flex max-w-full gap-2 overflow-x-auto pb-2" role="group" aria-label="Practice periods">
      {buckets.map(bucket => {
        const start = Date.parse(bucket.startsAt), end = Date.parse(bucket.endsAt), current = start <= now && now < end;
        const state = bucket.complete ? "met" : end <= now ? "missed" : current ? "current" : "upcoming";
        const period = assignment.requirement.recurrence === "weekly" ? "Week of " : assignment.requirement.recurrence === "monthly" ? "Month of " : "";
        const date = new Intl.DateTimeFormat("en", { timeZone: zone, month: "short", day: "numeric" }).format(new Date(start));
        const label = `${period}${date}: ${bucket.playedGames} of ${bucket.requiredGames} games`;
        return <button key={bucket.key} type="button" onClick={() => onSelect(bucket.key)} title={label} aria-label={`${label} · ${state}`} aria-pressed={selected === bucket.key}
          className={`min-h-11 shrink-0 rounded-lg border px-3 text-caption focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent ${bucket.complete ? "border-success/40 bg-success/10 text-success" : end <= now ? "border-danger/40 bg-danger/10 text-danger" : "border-border text-text-dim"} ${current ? "ring-2 ring-accent ring-offset-2 ring-offset-bg-surface" : ""}`}>
          <span className="block">{date}</span><span className="block text-micro">{bucket.playedGames}/{bucket.requiredGames}</span>
        </button>;
      })}
    </div>
    {assignment.requirement.recurrence !== "once" ? <p className="text-caption text-text-muted">Streak: {streak} {cadenceNoun(assignment.requirement.recurrence)}{streak === 1 ? "" : "s"}</p> : null}
    {selected ? <p className="text-micro text-text-dim">{(() => { const bucket = buckets.find(item => item.key === selected); return bucket ? formatWindow(bucket.startsAt, bucket.endsAt, zone) : ""; })()}</p> : null}
  </div>;
}
