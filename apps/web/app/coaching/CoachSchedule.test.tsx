import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CalendarPayload } from "./coachingScheduleModel";
const api = vi.hoisted(() => ({ call: vi.fn(), token: vi.fn(async () => "token"), success: vi.fn(), error: vi.fn(), calendar: undefined as CalendarPayload | undefined, refresh: vi.fn() }));
vi.mock("@clerk/nextjs", () => ({ useAuth: () => ({ getToken: api.token }) }));
vi.mock("@/lib/clientApi", () => ({ apiCall: api.call, useApi: () => ({ data: api.calendar, mutate: api.refresh }) }));
vi.mock("@/components/ui/Toast", () => ({ useToast: () => ({ toast: { success: api.success, error: api.error } }) }));
vi.mock("./coachingTime", async (importOriginal) => ({ ...await importOriginal<typeof import("./coachingTime")>(), useLocalTimeZone: () => "UTC", useZoneClock: () => "12:00" }));
import { CoachSchedule } from "./CoachSchedule";
import CoachingSchedule from "./CoachingSchedule";

function payload(): CalendarPayload {
  return { role: "coach", coach: { id: "coach", name: "Coach Jay" }, viewerTimeZone: "UTC", availabilityRev: 7,
    availability: { enabled: true, timeZone: "UTC", durations: [60], windows: [{ day: 1, startMinute: 540, endMinute: 600 }], updatedAt: "2026-10-01" },
    bookings: [{ id: "booked", studentName: "Player", startAt: "2034-10-23T14:00:00Z", endAt: "2034-10-23T15:00:00Z", durationMinutes: 60, status: "booked", cancelledBy: null, createdAt: "2026-10-01" }], unreadAlerts: [], slots: [] };
}
beforeEach(() => { api.call.mockReset(); api.refresh.mockReset(); api.success.mockReset(); api.error.mockReset(); api.calendar = payload(); });
afterEach(cleanup);

describe("availability drafts and published bookings", () => {
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
