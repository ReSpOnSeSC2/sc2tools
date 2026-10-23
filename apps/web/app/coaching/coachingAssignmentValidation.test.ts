import { afterEach, describe, expect, it, vi } from "vitest";
import { assignmentSummary, validateAssignmentDraft, type AssignmentDraft } from "./coachingPracticeModel";
import { assignmentTimeZone, rememberAssignmentTimeZone } from "./coachingAssignmentPreferences";
import { minuteValue, timeZoneOptions, windowProblems } from "./coachingTime";

export function validDraft(overrides: Partial<AssignmentDraft> = {}): AssignmentDraft {
  return { studentId: "alex", type: "build", requiredGames: "5", buildSelection: "manual", buildName: "Phoenix opener",
    recurrence: "weekly", totalRangeInitialized: false, dateRangeEdited: false, startsOn: "2026-10-20", endsOn: "2026-10-26",
    timeZone: "Europe/Berlin", title: "", note: "", clientRequestId: "request", ...overrides };
}
const context = { assignableStudents: [{ id: "alex", name: "Alex" }], buildOptions: [{ id: "phoenix", name: "Phoenix opener", matchBy: "slug" as const }] };
afterEach(() => { vi.restoreAllMocks(); localStorage.clear(); });

describe("assignment validation", () => {
  it.each([
    [{ studentId: "" }, "studentId"], [{ studentId: "unapproved" }, "studentId"],
    [{ requiredGames: "" }, "requiredGames"], [{ requiredGames: "1.5" }, "requiredGames"],
    [{ requiredGames: "0" }, "requiredGames"], [{ requiredGames: "1001" }, "requiredGames"],
    [{ buildName: "  " }, "buildName"], [{ buildSelection: "slug:someone-else" }, "buildSelection"],
    [{ startsOn: "2026-02-30" }, "startsOn"], [{ endsOn: "bad" }, "endsOn"],
    [{ endsOn: "2026-10-19" }, "endsOn"], [{ endsOn: "2027-10-21" }, "endsOn"],
    [{ timeZone: "" }, "timeZone"], [{ timeZone: "wrong/time-zone" }, "timeZone"],
  ] as const)("rejects %j on the correct field", (patch, field) => {
    expect(validateAssignmentDraft(validDraft(patch), context)[field]).toBeTruthy();
  });
  it("accepts both count boundaries, a 366-day inclusive range, and available custom identities", () => {
    for (const requiredGames of ["1", "1000"]) expect(validateAssignmentDraft(validDraft({ requiredGames, endsOn: "2027-10-20", buildSelection: "slug:phoenix" }), context)).toEqual({});
    expect(validateAssignmentDraft(validDraft({ type: "total", buildName: "", buildSelection: "removed" }), context)).toEqual({});
  });
  it("reports all invalid fields together without treating a total target as a missing build", () => {
    expect(Object.keys(validateAssignmentDraft(validDraft({ type: "total", studentId: "", requiredGames: "0", endsOn: "2026-10-19", timeZone: "" }), context)))
      .toEqual(["studentId", "requiredGames", "endsOn", "timeZone"]);
  });
});

describe("assignment summary", () => {
  it("describes the actual one-window build target and each recurring cadence without promising results", () => {
    expect(assignmentSummary(validDraft(), "Alex")).toBe("Alex plays 5 eligible 1v1 games using Phoenix opener, Oct 20, 2026–Oct 26, 2026 (Europe/Berlin).");
    for (const [recurrence, cadence] of [["daily", "day"], ["weekly", "week"], ["monthly", "month"]] as const) {
      expect(assignmentSummary(validDraft({ type: "total", recurrence, requiredGames: "1" }), "Alex")).toContain(`1 eligible 1v1 game each ${cadence},`);
    }
  });
  it.each([{ buildName: "" }, { studentId: "" }, { startsOn: "" }, { endsOn: "2026-01-01" }, { requiredGames: "0" }, { timeZone: "invalid" }])("hides an incomplete summary for %j", (patch) => {
    expect(assignmentSummary(validDraft(patch), "Alex")).toBeNull();
  });
});

describe("student time-zone preferences", () => {
  it("remembers each student's last used zone and lists it ahead of browser and other zones", () => {
    rememberAssignmentTimeZone("alex", "Europe/Berlin"); rememberAssignmentTimeZone("blair", "Asia/Tokyo");
    expect(assignmentTimeZone("alex", "America/New_York")).toBe("Europe/Berlin");
    expect(assignmentTimeZone("blair", "America/New_York")).toBe("Asia/Tokyo");
    expect(timeZoneOptions("UTC", ["Europe/Berlin", "America/New_York"]).slice(0, 2)).toEqual(["Europe/Berlin", "America/New_York"]);
  });
  it("ignores invalid saved zones and works when reading and writing storage throw", () => {
    localStorage.setItem("sc2tools:coaching:tz:alex", "bogus");
    expect(assignmentTimeZone("alex", "Asia/Tokyo")).toBe("Asia/Tokyo");
    vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => { throw new Error("blocked"); });
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => { throw new Error("full"); });
    expect(assignmentTimeZone("alex", "UTC")).toBe("UTC");
    expect(() => rememberAssignmentTimeZone("alex", "UTC")).not.toThrow();
  });
});

describe("weekly window validation", () => {
  const hours = (day: number, start: string, end: string) => ({ day, startMinute: minuteValue(start), endMinute: minuteValue(end) });
  it("rejects reversed and empty times, and identifies both overlapping windows on the same day", () => {
    expect(windowProblems([hours(1, "12:00", "09:00")])).toEqual({ 0: "Ends before it starts." });
    expect(windowProblems([hours(1, "12:00", "12:00")])).toEqual({ 0: "Ends before it starts." });
    expect(windowProblems([hours(1, "", "09:00")])).toEqual({ 0: "Choose a start and end time." });
    expect(windowProblems([hours(1, "09:00", "12:00"), hours(1, "11:30", "14:00")])).toEqual({ 0: "Overlaps 11:30–14:00.", 1: "Overlaps 9:00–12:00." });
  });
  it("allows touching windows and the same clock times on different days", () => {
    expect(windowProblems([hours(1, "09:00", "12:00"), hours(1, "12:00", "14:00"), hours(2, "09:00", "12:00")])).toEqual({});
  });
});
