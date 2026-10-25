"use client";
import { useMemo } from "react";
import { practiceRoster, bucketPace } from "./coachingPracticeProgress";
import { formatGameDate, type PracticeAssignment, type Student } from "./coachingPracticeModel";

export function PracticeRoster({ students, assignments, now, truncated, onSelect }: { students: readonly Student[]; assignments: readonly PracticeAssignment[]; now: number; truncated: boolean; onSelect: (id: string) => void }) {
  const rows = useMemo(() => practiceRoster(students, assignments, now), [students, assignments, now]);
  const lastGame = (value: string | null) => value ? formatGameDate(value, "UTC") + " UTC" : "None yet";
  const pace = (row: typeof rows[number]) => row.behind.length ? row.behind.map(plan => {
    const bucket = plan.progress.currentBucket!, { daysLeft } = bucketPace(bucket, now);
    return `Behind schedule · ${bucket.playedGames} of ${bucket.requiredGames} games, ${daysLeft} day${daysLeft === 1 ? "" : "s"} left`;
  }).join("; ") : "No plan behind schedule";
  return <section aria-label="Practice roster" className="min-w-0 space-y-3">
    <h3 className="text-h4 font-semibold text-text">All players</h3>
    <p className="text-caption text-text-muted">Students with approved practice sharing. Last qualifying game refers to their active plans; dates below are in UTC. Select a player above to request approval or read their history.</p>
    {truncated ? <p role="status" className="text-caption text-warning">Showing the newest 100 active plans. Counts and schedule flags below are partial; select a player for their complete plan history.</p> : null}
    <div className="hidden overflow-x-auto rounded-xl border border-border md:block"><table className="w-full text-left text-caption"><thead><tr className="border-b border-border"><th className="p-3">Student</th><th className="p-3">Active plans</th><th className="p-3">Schedule pace</th><th className="p-3">Last qualifying game</th></tr></thead><tbody>{rows.map(row => <tr key={row.student.id} onClick={event => { if (!(event.target as HTMLElement).closest("button")) onSelect(row.student.id); }} className="cursor-pointer border-b border-border last:border-0"><th className="p-3"><button type="button" onClick={() => onSelect(row.student.id)} className="min-h-11 text-accent underline underline-offset-4">{row.student.name}</button></th><td className="p-3">{truncated ? "At least " : ""}{row.plans.length}</td><td className="p-3">{truncated && !row.behind.length ? "Unknown outside this sample" : pace(row)}</td><td className="p-3">{row.lastGameAt ? lastGame(row.lastGameAt) : truncated ? "Not in this sample" : "None yet"}</td></tr>)}</tbody></table></div>
    <ul className="space-y-3 md:hidden">{rows.map(row => <li key={row.student.id} onClick={event => { if (!(event.target as HTMLElement).closest("button")) onSelect(row.student.id); }} className="cursor-pointer rounded-xl border border-border bg-bg-surface p-4"><button type="button" onClick={() => onSelect(row.student.id)} className="min-h-11 text-body font-semibold text-accent underline">{row.student.name}</button><p className="text-caption text-text">{truncated ? "At least " : ""}{row.plans.length} active plan{row.plans.length === 1 ? "" : "s"}</p><p className="mt-2 text-caption text-text-muted">{truncated && !row.behind.length ? "Schedule pace unknown outside this sample" : pace(row)}</p><p className="mt-2 text-caption text-text-muted">Last qualifying game: {row.lastGameAt ? lastGame(row.lastGameAt) : truncated ? "Not in this sample" : "None yet"}</p></li>)}</ul>
  </section>;
}
