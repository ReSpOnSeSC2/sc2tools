import { describe, expect, it } from "vitest";
import { localDateKey, nextWindowDraft, type PracticeAssignment, type ProgressBucket } from "./coachingPracticeModel";
import { bucketPace, completedPeriodStreak, practiceRoster } from "./coachingPracticeProgress";

export function planFixture(): PracticeAssignment {
  return { id: "plan", rev: 1, status: "active", student: { id: "student", name: "Student" }, coach: { id: "coach", name: "Coach" }, createdAt: "2026-01-01T00:00:00Z", updatedAt: "2026-01-01T00:00:00Z",
    requirement: { type: "build", requiredGames: 5, recurrence: "once", timeZone: "America/New_York", build: { id: "blink", name: "Blink", matchBy: "slug" }, title: "Practice", note: "Keep scouting", window: { startsOn: "2026-03-07", endsOn: "2026-03-13", startsAt: "2026-03-07T05:00:00Z", endsAt: "2026-03-14T04:00:00Z", endExclusive: true } },
    progress: { state: "active", playedGames: 0, requiredGamesTotal: 5, completedBuckets: 0, totalBuckets: 1, currentBucket: null, buckets: [], games: [], replayGames: [], gamesTruncated: false } };
}
export const bucketFixture = (patch: Partial<ProgressBucket> = {}): ProgressBucket => ({ key: "week", startsAt: "2026-10-19T00:00:00Z", endsAt: "2026-10-26T00:00:00Z", playedGames: 2, requiredGames: 5, remainingGames: 3, complete: false, ...patch });

describe("repeat plan calendar draft", () => {
  it("copies the full target and inclusive calendar length through a DST shift without request identity", () => {
    const plan = planFixture(), draft = nextWindowDraft(plan, "2026-03-10");
    expect(draft).toMatchObject({ startsOn: "2026-03-14", endsOn: "2026-03-20", studentId: "student", type: "build", requiredGames: "5", buildSelection: "slug:blink", buildName: "Blink", timeZone: "America/New_York", title: "Practice", note: "Keep scouting", dateRangeEdited: true });
    expect(draft).not.toHaveProperty("clientRequestId"); expect(plan.requirement.window.startsOn).toBe("2026-03-07");
    expect(nextWindowDraft(plan, "2026-11-01")).toMatchObject({ startsOn: "2026-11-01", endsOn: "2026-11-07" });
  });
  it("aligns recurring windows forward, preserving their inclusive day length across month/year ends", () => {
    const plan = planFixture(); plan.requirement.type = "total"; plan.requirement.recurrence = "weekly";
    expect(nextWindowDraft(plan, "2026-03-15")).toMatchObject({ startsOn: "2026-03-16", endsOn: "2026-03-22", recurrence: "weekly" });
    plan.requirement.recurrence = "monthly"; plan.requirement.window.startsOn = "2025-12-01"; plan.requirement.window.endsOn = "2025-12-31";
    expect(nextWindowDraft(plan, "2026-01-01")).toMatchObject({ startsOn: "2026-01-01", endsOn: "2026-01-31" });
    expect(nextWindowDraft(plan, "2026-02-02")).toMatchObject({ startsOn: "2026-03-01", endsOn: "2026-03-31" });
    expect(nextWindowDraft(plan, "2026-02-01")).toMatchObject({ startsOn: "2026-02-01", endsOn: "2026-03-03" });
  });
  it("maps legacy once total targets to the modal weekly draft and uses the plan's local today", () => {
    const plan = planFixture(); plan.requirement.type = "total";
    const key = localDateKey(new Date("2026-11-02T02:00:00Z"), plan.requirement.timeZone);
    expect(key).toBe("2026-11-01"); expect(nextWindowDraft(plan, key)).toMatchObject({ startsOn: key, endsOn: "2026-11-07", recurrence: "weekly", totalRangeInitialized: true });
  });
});

describe("schedule facts", () => {
  it("uses floor of elapsed target, preserves zero and avoids flags outside the current bucket", () => {
    const bucket = bucketFixture();
    expect(bucketPace(bucket, Date.parse("2026-10-23T12:00:00Z"))).toEqual({ behind: true, dueGames: 3, daysLeft: 3 });
    expect(bucketPace({ ...bucket, playedGames: 3 }, Date.parse("2026-10-23T12:00:00Z")).behind).toBe(false);
    expect(bucketPace(bucket, Date.parse(bucket.endsAt)).behind).toBe(false);
    expect(bucketPace(null, Date.now()).behind).toBe(false);
  });
  it("counts consecutive completed finished periods, excluding current and future completions", () => {
    const now = Date.parse("2026-10-26T00:00:00Z"), buckets = [0, 1, 2].map((i) => bucketFixture({ key: String(i), startsAt: `2026-10-${19 + i}T00:00:00Z`, endsAt: `2026-10-${20 + i}T00:00:00Z`, complete: true }));
    buckets.push(bucketFixture({ key: "current", startsAt: "2026-10-26T00:00:00Z", endsAt: "2026-11-02T00:00:00Z", complete: true }));
    expect(completedPeriodStreak(buckets, now)).toBe(3); buckets[1].complete = false; expect(completedPeriodStreak(buckets, now)).toBe(1);
  });
  it("sorts behind students first and retains only each student's known latest qualifying game", () => {
    const plan = planFixture(); plan.progress.currentBucket = bucketFixture(); plan.progress.lastGameAt = "2026-10-22T12:00:00Z";
    const rows = practiceRoster([{ id: "ahead", name: "A" }, plan.student], [plan], Date.parse("2026-10-23T12:00:00Z"));
    expect(rows[0]).toMatchObject({ student: plan.student, lastGameAt: "2026-10-22T12:00:00Z" }); expect(rows[1].lastGameAt).toBeNull();
  });
});
