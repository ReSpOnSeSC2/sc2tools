import { describe, expect, it } from "vitest";
import { endClockValue, endMinuteValue, googleCalendarUrl, splitSessions } from "./coachingTime";
import type { Booking } from "./coachingScheduleModel";

function booking(id: string, startAt: string, endAt: string, extra: Partial<Booking> = {}): Booking {
  return { id, studentName: "Alex", startAt, endAt, durationMinutes: 60, status: "booked", cancelledBy: null, createdAt: "2026-02-01T12:00:00.000Z", ...extra };
}

const coach = { role: "coach" as const, coachName: "Coach Jay", origin: "https://sc2tools.com" };
const student = { role: "student" as const, coachName: "Coach Jay", origin: "https://sc2tools.com" };

describe("Google Calendar template links", () => {
  it("names only the other person and links back to the Sessions tab", () => {
    const url = new URL(googleCalendarUrl(booking("b1", "2026-10-22T18:00:00.000Z", "2026-10-22T19:00:00.000Z"), coach));
    expect(`${url.origin}${url.pathname}`).toBe("https://calendar.google.com/calendar/render");
    expect(url.searchParams.get("action")).toBe("TEMPLATE");
    expect(url.searchParams.get("text")).toBe("SC2 coaching with Alex");
    expect(url.searchParams.get("details")).toBe("Coaching session booked in SC2 Tools. Your sessions: https://sc2tools.com/coaching?view=schedule");
    const asStudent = new URL(googleCalendarUrl(booking("b1", "2026-10-22T18:00:00.000Z", "2026-10-22T19:00:00.000Z"), student));
    expect(asStudent.searchParams.get("text")).toBe("SC2 coaching with Coach Jay");
    expect(asStudent.toString()).not.toContain("Alex");
  });

  it("encodes reserved characters and keeps UTC times across daylight-saving changes", () => {
    const spring = booking("b2", "2026-03-08T06:30:00.000Z", "2026-03-08T07:30:00.000Z", { studentName: "A&B = C/D?" });
    const fall = booking("b3", "2026-11-01T05:30:00.000Z", "2026-11-01T07:00:00.000Z");
    const springUrl = googleCalendarUrl(spring, coach);
    expect(springUrl).toContain("text=SC2+coaching+with+A%26B+%3D+C%2FD%3F");
    expect(new URL(springUrl).searchParams.get("dates")).toBe("20260308T063000Z/20260308T073000Z");
    expect(new URL(googleCalendarUrl(fall, coach)).searchParams.get("dates")).toBe("20261101T053000Z/20261101T070000Z");
  });
});

describe("sessions and midnight ends", () => {
  it("keeps sessions in progress upcoming and lists ended sessions newest first", () => {
    const now = Date.parse("2026-10-20T12:00:00.000Z");
    const { upcoming, past } = splitSessions([
      booking("later", "2026-10-25T18:00:00.000Z", "2026-10-25T19:00:00.000Z"),
      booking("now", "2026-10-20T11:30:00.000Z", "2026-10-20T12:30:00.000Z"),
      booking("old", "2026-10-01T18:00:00.000Z", "2026-10-01T19:00:00.000Z"),
      booking("cancelled-old", "2026-10-05T18:00:00.000Z", "2026-10-05T19:00:00.000Z", { status: "cancelled", cancelledBy: "student" }),
      booking("cancelled-future", "2026-10-30T18:00:00.000Z", "2026-10-30T19:00:00.000Z", { status: "cancelled", cancelledBy: "coach" }),
    ], now);
    expect(upcoming.map((item) => item.id)).toEqual(["now", "later"]);
    expect(past.map((item) => item.id)).toEqual(["cancelled-old", "old"]);
  });

  it("shows a 24:00 end as 00:00 and reads 00:00 back as the end of the day", () => {
    expect(endClockValue(24 * 60)).toBe("00:00");
    expect(endClockValue(20 * 60)).toBe("20:00");
    expect(endMinuteValue("00:00")).toBe(1440);
    expect(endMinuteValue("22:30")).toBe(1350);
  });
});
