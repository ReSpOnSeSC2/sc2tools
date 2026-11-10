import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CalendarPayload, SessionHistory } from "./coachingScheduleModel";
const api = vi.hoisted(() => ({ call: vi.fn(), token: vi.fn(async () => "token"), success: vi.fn(), error: vi.fn(), calendar: undefined as CalendarPayload | undefined, history: undefined as SessionHistory | undefined, refresh: vi.fn() }));
vi.mock("@clerk/nextjs", () => ({ useAuth: () => ({ getToken: api.token }) }));
vi.mock("@/lib/clientApi", () => ({ apiCall: api.call, useApi: (path: string | null) => path?.includes("/digest") ? { data: undefined, mutate: vi.fn() } : path?.includes("past=1") ? { data: api.history, mutate: vi.fn() } : { data: api.calendar, mutate: api.refresh } }));
vi.mock("@/components/ui/Toast", () => ({ useToast: () => ({ toast: { success: api.success, error: api.error } }) }));
vi.mock("./coachingTime", async (importOriginal) => ({ ...await importOriginal<typeof import("./coachingTime")>(), useLocalTimeZone: () => "UTC", useZoneClock: () => "12:00" }));
import { CoachSchedule } from "./CoachSchedule";
import CoachingSchedule from "./CoachingSchedule";

function payload(): CalendarPayload {
  return { role: "coach", coach: { id: "coach", name: "Coach Jay" }, viewerTimeZone: "UTC", availabilityRev: 7,
    availability: { enabled: true, timeZone: "UTC", durations: [60], windows: [{ day: 1, startMinute: 540, endMinute: 600 }], updatedAt: "2026-10-01" },
    bookings: [{ id: "booked", studentName: "Player", startAt: "2034-10-23T14:00:00Z", endAt: "2034-10-23T15:00:00Z", durationMinutes: 60, status: "booked", cancelledBy: null, createdAt: "2026-10-01" }], unreadAlerts: [], slots: [] };
}
beforeEach(() => { api.call.mockReset(); api.refresh.mockReset(); api.success.mockReset(); api.error.mockReset(); api.calendar = payload(); api.history = undefined; });
afterEach(cleanup);

describe("availability drafts and published bookings", () => {
  it("blocks reversed or overlapping hours with inline errors, and permits touching windows after correction", () => {
    render(<CoachSchedule data={payload()} localTimeZone="UTC" refresh={api.refresh} active />);
    const start = screen.getByLabelText("Monday start time 1");
    start.focus();
    fireEvent.change(start, { target: { value: "11:00" } });
    expect(document.activeElement).toBe(start);
    expect(start.getAttribute("aria-invalid")).toBe("true");
    expect(document.getElementById(start.getAttribute("aria-describedby")!)?.textContent).toBe("Ends before it starts.");
    const publish = screen.getByRole("button", { name: "Publish availability" });
    expect(publish.hasAttribute("disabled")).toBe(true);
    expect(screen.getByText("Fix the highlighted hours to publish")).toBeTruthy();
    fireEvent.click(publish); expect(api.call).not.toHaveBeenCalled();
    fireEvent.change(start, { target: { value: "09:00" } });
    fireEvent.click(screen.getByRole("button", { name: "Add hours" }));
    // Add hours starts where the last window ends, so it never overlaps.
    expect((screen.getByLabelText("Monday start time 2") as HTMLInputElement).value).toBe("10:00");
    expect((screen.getByLabelText("Monday end time 2") as HTMLInputElement).value).toBe("12:00");
    fireEvent.change(screen.getByLabelText("Monday start time 2"), { target: { value: "09:30" } });
    expect(screen.getByLabelText("Monday end time 2").getAttribute("aria-invalid")).toBe("true");
    expect(publish.hasAttribute("disabled")).toBe(true);
    fireEvent.change(screen.getByLabelText("Monday start time 2"), { target: { value: "10:00" } });
    expect(screen.queryByRole("alert")).toBeNull();
    expect(publish.hasAttribute("disabled")).toBe(false);
  });

  it("keeps booked times in the saved zone while editing, and Reset clears the draft and unload guard", () => {
    const dirty = vi.fn(); render(<CoachSchedule data={payload()} localTimeZone="UTC" refresh={api.refresh} active onDirtyChange={dirty} />);
    const bookings = screen.getByRole("heading", { name: "Upcoming sessions" }).closest("section")!;
    const original = bookings.textContent;
    fireEvent.change(screen.getByRole("combobox", { name: "Coaching timezone" }), { target: { value: "Asia/Tokyo" } });
    expect(bookings.textContent).toBe(original); expect(within(bookings).getByText("Shown in UTC")).toBeTruthy();
    expect(screen.getByRole("region", { name: "Unsaved changes" })).toBeTruthy(); expect(dirty).toHaveBeenLastCalledWith(true);
    const leaving = new Event("beforeunload", { cancelable: true }); window.dispatchEvent(leaving); expect(leaving.defaultPrevented).toBe(true);
    fireEvent.click(within(bookings).getByRole("button", { name: "Cancel session" }));
    expect(screen.getByRole("dialog").textContent).toContain("UTC");
    fireEvent.click(screen.getByRole("button", { name: "Keep session" }));
    fireEvent.click(screen.getByRole("button", { name: "Reset" }));
    expect((screen.getByRole("combobox", { name: "Coaching timezone" }) as HTMLSelectElement).value).toBe("UTC");
    expect(screen.queryByRole("region", { name: "Unsaved changes" })).toBeNull();
    const cleanLeave = new Event("beforeunload", { cancelable: true }); window.dispatchEvent(cleanLeave); expect(cleanLeave.defaultPrevented).toBe(false);
  });

  it("publishes the draft once, adopts the authoritative revision, and keeps failed drafts available", async () => {
    api.call.mockRejectedValueOnce(new Error("offline"));
    render(<CoachSchedule data={payload()} localTimeZone="UTC" refresh={api.refresh} active />);
    fireEvent.change(screen.getByLabelText("Monday start time 1"), { target: { value: "08:00" } });
    fireEvent.click(screen.getByRole("button", { name: "Publish availability" }));
    await waitFor(() => expect(api.error).toHaveBeenCalledWith("Availability was not saved", expect.anything()));
    expect((screen.getByLabelText("Monday start time 1") as HTMLInputElement).value).toBe("08:00");
    const next = payload(); next.availabilityRev = 8; next.availability!.updatedAt = "2026-10-23"; next.availability!.windows[0].startMinute = 480;
    api.call.mockResolvedValueOnce(next); api.refresh.mockResolvedValue(next);
    fireEvent.click(screen.getByRole("button", { name: "Publish availability" }));
    await waitFor(() => expect(api.success).toHaveBeenCalledWith("Availability published", expect.anything()));
    expect(JSON.parse(api.call.mock.calls[1][2].body)).toMatchObject({ expectedRev: 7, windows: [{ day: 1, startMinute: 480, endMinute: 600 }] });
    expect(api.refresh).toHaveBeenCalledWith(next, { revalidate: false });
    expect(screen.queryByRole("region", { name: "Unsaved changes" })).toBeNull();
    expect((screen.getByLabelText("Monday start time 1") as HTMLInputElement).value).toBe("08:00");
  });

  it("does not mark newly arrived alerts read while Sessions is hidden", async () => {
    api.calendar!.unreadAlerts = [{ bookingId: "booked", updatedAt: "now" }]; api.call.mockResolvedValue({});
    const view = render(<CoachingSchedule active={false} />);
    expect(api.call).not.toHaveBeenCalled(); view.rerender(<CoachingSchedule active />);
    await waitFor(() => expect(api.call).toHaveBeenCalledWith(api.token, "/v1/coaching/alerts/read", expect.anything()));
    view.rerender(<CoachingSchedule active={false} />); api.calendar = { ...api.calendar!, unreadAlerts: [{ bookingId: "later", updatedAt: "later" }] };
    view.rerender(<CoachingSchedule active={false} />); expect(api.call).toHaveBeenCalledTimes(1);
  });
});

describe("faster weekly hours", () => {
  it("copies a day to the weekdays with a replace warning and an Undo that lasts 10 seconds", async () => {
    vi.useFakeTimers();
    try {
      const data = payload();
      data.availability!.windows = [{ day: 1, startMinute: 540, endMinute: 600 }, { day: 3, startMinute: 1080, endMinute: 1200 }];
      render(<CoachSchedule data={data} localTimeZone="UTC" refresh={api.refresh} active />);
      fireEvent.click(screen.getByRole("button", { name: "Monday hours actions" }));
      fireEvent.click(screen.getByRole("menuitem", { name: "Copy to weekdays (replaces 1 day)" }));
      for (const day of ["Tuesday", "Wednesday", "Thursday", "Friday"]) {
        expect((screen.getByLabelText(`${day} start time 1`) as HTMLInputElement).value).toBe("09:00");
        expect(screen.queryByLabelText(`${day} start time 2`)).toBeNull();
      }
      expect(screen.queryByLabelText("Saturday start time 1")).toBeNull();
      expect(screen.getByRole("status").textContent).toContain("Copied Monday's hours to the weekdays.");
      fireEvent.click(screen.getByRole("button", { name: /^Undo/ }));
      expect((screen.getByLabelText("Wednesday start time 1") as HTMLInputElement).value).toBe("18:00");
      expect(screen.queryByLabelText("Tuesday start time 1")).toBeNull();
      fireEvent.click(screen.getByRole("button", { name: "Monday hours actions" }));
      fireEvent.click(screen.getByRole("menuitem", { name: "Copy to all days (replaces 1 day)" }));
      expect((screen.getByLabelText("Sunday start time 1") as HTMLInputElement).value).toBe("09:00");
      act(() => { vi.advanceTimersByTime(10_000); });
      expect(screen.queryByRole("button", { name: /^Undo/ })).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it("clears a day, and starts an empty day from a preset or 18:00", () => {
    render(<CoachSchedule data={payload()} localTimeZone="UTC" refresh={api.refresh} active />);
    fireEvent.click(screen.getByRole("button", { name: "Monday hours actions" }));
    fireEvent.click(screen.getByRole("menuitem", { name: "Clear day" }));
    expect(screen.queryByLabelText("Monday start time 1")).toBeNull();
    expect(screen.queryByRole("button", { name: "All day 10:00–18:00 on Monday" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "All day 10:00–18:00 on Saturday" }));
    expect((screen.getByLabelText("Saturday end time 1") as HTMLInputElement).value).toBe("18:00");
    fireEvent.click(screen.getByRole("button", { name: "Evenings 18:00–22:00 on Tuesday" }));
    expect((screen.getByLabelText("Tuesday start time 1") as HTMLInputElement).value).toBe("18:00");
    expect((screen.getByLabelText("Tuesday end time 1") as HTMLInputElement).value).toBe("22:00");
    const thursday = screen.getAllByRole("button", { name: "Set hours" })[2];
    fireEvent.click(thursday);
    expect((screen.getByLabelText("Thursday start time 1") as HTMLInputElement).value).toBe("18:00");
    expect((screen.getByLabelText("Thursday end time 1") as HTMLInputElement).value).toBe("20:00");
  });
});

describe("booking calendar links and past sessions", () => {
  it("adds a Google Calendar link and an .ics file to each upcoming session", () => {
    render(<CoachSchedule data={payload()} localTimeZone="UTC" refresh={api.refresh} active />);
    const google = screen.getByRole("link", { name: /Add to Google Calendar/ });
    expect(google.getAttribute("target")).toBe("_blank");
    expect(google.getAttribute("rel")).toBe("noopener noreferrer");
    const url = new URL(google.getAttribute("href")!);
    expect(url.searchParams.get("text")).toBe("SC2 coaching with Player");
    expect(url.searchParams.get("dates")).toBe("20341023T140000Z/20341023T150000Z");
    const ics = screen.getByRole("link", { name: "Download .ics" });
    expect(ics.getAttribute("download")).toBe("sc2-coaching-2034-10-23.ics");
    expect(decodeURIComponent(ics.getAttribute("href")!.split(",")[1])).toContain("UID:booked@sc2tools.com\r\n");
  });

  it("lists the complete history with per-student counts and marks cancelled sessions", () => {
    api.history = {
      role: "coach", total: 63, held: 60, limit: 50, hasMore: true,
      bookings: [
        { id: "p1", studentName: "Alex", startAt: "2026-10-01T14:00:00Z", endAt: "2026-10-01T15:00:00Z", durationMinutes: 60, status: "cancelled", cancelledBy: "student", createdAt: "2026-09-01" },
        { id: "p2", studentName: "Blair", startAt: "2026-09-20T14:00:00Z", endAt: "2026-09-20T15:00:00Z", durationMinutes: 60, status: "booked", cancelledBy: null, createdAt: "2026-09-01" },
      ],
      students: [{ studentId: "s1", name: "Alex", held: 6, cancelled: 1 }, { studentId: "s2", name: "Blair", held: 54, cancelled: 2 }],
    };
    render(<CoachingSchedule active />);
    const past = screen.getByText("Past sessions (63)").closest("details")!;
    expect(within(past).getByRole("list", { name: "Past sessions per student" }).textContent).toContain("Alex · 6 (1 cancelled)");
    expect(within(past).getByText("Cancelled by the student")).toBeTruthy();
    expect(within(past).getByText("Showing the latest 2 of 63.")).toBeTruthy();
  });
});
