import type { PracticeAssignment, ProgressBucket, Student } from "./coachingPracticeModel";

export function bucketPace(bucket: ProgressBucket | null, now: number) {
  if (!bucket) return { behind: false, dueGames: 0, daysLeft: 0 };
  const start = Date.parse(bucket.startsAt), end = Date.parse(bucket.endsAt);
  const elapsed = end > start ? Math.max(0, Math.min(1, (now - start) / (end - start))) : 0;
  const dueGames = Math.floor(bucket.requiredGames * elapsed);
  return { behind: now >= start && now < end && bucket.playedGames < dueGames, dueGames, daysLeft: Math.max(0, Math.ceil((end - now) / 86_400_000)) };
}

export function completedPeriodStreak(buckets: readonly ProgressBucket[], now: number): number {
  const finished = buckets.filter(bucket => Date.parse(bucket.endsAt) <= now).sort((a, b) => a.endsAt.localeCompare(b.endsAt));
  let count = 0;
  for (let index = finished.length - 1; index >= 0 && finished[index].complete; index--) count++;
  return count;
}

export function practiceRoster(students: readonly Student[], assignments: readonly PracticeAssignment[], now: number) {
  return students.map(student => {
    const plans = assignments.filter(assignment => assignment.student.id === student.id && assignment.status === "active");
    const behind = plans.filter(plan => bucketPace(plan.progress.currentBucket, now).behind);
    const last = plans.flatMap(plan => plan.progress.lastGameAt && Number.isFinite(Date.parse(plan.progress.lastGameAt)) ? [plan.progress.lastGameAt] : []).sort().at(-1) ?? null;
    return { student, plans, behind, lastGameAt: last };
  }).sort((a, b) => Number(b.behind.length > 0) - Number(a.behind.length > 0) || a.student.name.localeCompare(b.student.name));
}

