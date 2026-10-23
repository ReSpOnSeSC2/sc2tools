import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AdminEvent } from "./adminTypes";

const { apiCallMock } = vi.hoisted(() => ({ apiCallMock: vi.fn() }));
vi.mock("@clerk/nextjs", () => ({ useAuth: () => ({ getToken: async () => "fixture-token" }) }));
vi.mock("@/lib/clientApi", () => ({ apiCall: (...args: unknown[]) => apiCallMock(...args) }));
import { AdminEventRow } from "./AdminEventRow";

const report: AdminEvent = {
  eventId: "report:with/slash", type: "user_message", createdAt: "2026-10-23T12:00:00Z", readAt: null,
  payload: { userId: "account/one", clerkUserId: "clerk-1", email: "player@example.test", subject: "Mobile chart cannot open", message: "First line\nFull support message details.",
    type: "problem", context: { page: "/app/opponents", viewport: "390x844", failedRequests: [{ path: "/v1/opponents", status: 503 }] } },
};
afterEach(cleanup);
beforeEach(() => apiCallMock.mockReset());

describe("admin activity details", () => {
  it("opens the actual full support content and diagnostics without marking it read", () => {
    render(<ul><AdminEventRow event={report} unread /></ul>);
    const trigger = screen.getByRole("button", { name: "Open details: Mobile chart cannot open" });
    expect(trigger.getAttribute("aria-haspopup")).toBe("dialog");
    fireEvent.click(trigger);
    const dialog = screen.getByRole("dialog", { name: "Mobile chart cannot open" });
    expect(within(dialog).getByText(/Full support message details/).textContent).toBe("First line\nFull support message details.");
    expect(within(dialog).getByText("1 failed request")).toBeTruthy();
    expect(within(dialog).getByText("503 · /v1/opponents")).toBeTruthy();
    expect(within(dialog).getByRole("link", { name: "Open account →" }).getAttribute("href")).toBe("/admin/users/account%2Fone");
    expect(apiCallMock).not.toHaveBeenCalled();
    fireEvent.keyDown(document, { key: "Escape" });
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(document.activeElement).toBe(trigger);
  });

  it("lets the opened message use the real reply control and preserves a failed reply", async () => {
    apiCallMock.mockRejectedValueOnce({ status: 503, message: "Temporarily unavailable" }).mockResolvedValue({ status: "new", revision: 1, replies: [{ id: "reply-1", message: "Please retry now.", createdAt: report.createdAt }] });
    render(<ul><AdminEventRow event={report} unread /></ul>);
    fireEvent.click(screen.getByRole("button", { name: "Open details: Mobile chart cannot open" }));
    const dialog = screen.getByRole("dialog");
    fireEvent.click(within(dialog).getByRole("button", { name: "Status / Reply" }));
    fireEvent.change(within(dialog).getByRole("textbox", { name: "Reply to the user" }), { target: { value: "Please retry now." } });
    fireEvent.click(within(dialog).getByRole("button", { name: "Save and send reply" }));
    await within(dialog).findByRole("alert");
    expect((within(dialog).getByRole("textbox", { name: "Reply to the user" }) as HTMLTextAreaElement).value).toBe("Please retry now.");
    expect(apiCallMock).toHaveBeenCalledWith(expect.any(Function), "/v1/admin/messages/report%3Awith%2Fslash", expect.objectContaining({ method: "PATCH" }));
    fireEvent.click(within(dialog).getByRole("button", { name: "Retry" }));
    await within(dialog).findByRole("button", { name: "Status / Reply" });
    expect(within(dialog).queryByRole("textbox")).toBeNull();
    expect(apiCallMock).toHaveBeenCalledTimes(2);
  });

  it.each([
    { eventId: "signup", type: "user_signup", payload: { userId: "account", clerkUserId: "clerk", email: "signup@example.test", source: "first_touch" }, title: "New signup", field: "Signup source" },
    { eventId: "install", type: "agent_connected", payload: { userId: "account", clerkUserId: "clerk", email: "agent@example.test", deviceId: "device", platform: "windows", version: "0.20.0", source: "heartbeat" }, title: "Agent connected · Windows v0.20.0", field: "Confirmed by" },
    { eventId: "download", type: "agent_download", payload: { platform: "windows", version: "0.20.0", channel: "stable", ip: null, userAgent: "Fixture browser", referer: null, country: "US" }, title: "Agent download · Windows v0.20.0", field: "Country" },
    { eventId: "job", type: "job_overdue", payload: { job: "guide-stats", intervalMs: 60000 }, title: "Background job overdue", field: "Scheduled interval (minutes)" },
    { eventId: "backup", type: "backup_stale", payload: { reason: "missing", lastSnapshotAt: null, ageHours: null, latestStatus: null }, title: "No database backup found", field: null },
  ])("opens $type activity with its complete fields", (sample) => {
    const event = { ...sample, createdAt: report.createdAt, readAt: null } as AdminEvent;
    render(<ul><AdminEventRow event={event} unread /></ul>);
    fireEvent.click(screen.getByRole("button", { name: `Open details: ${sample.title}` }));
    const dialog = screen.getByRole("dialog", { name: sample.title });
    expect(dialog.querySelector("time")?.getAttribute("datetime")).toBe(report.createdAt);
    if (sample.field) expect(within(dialog).getByText(sample.field)).toBeTruthy();
    if (sample.type === "job_overdue") expect(within(dialog).getByRole("link", { name: "Open Infrastructure →" }).getAttribute("href")).toBe("/admin/health#background-jobs");
    if (sample.type === "backup_stale") expect(within(dialog).getByRole("link", { name: "Open Infrastructure →" }).getAttribute("href")).toBe("/admin/health#database-backups-heading");
    fireEvent.click(within(dialog).getByRole("button", { name: "Close" }));
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("keeps deleted accounts unavailable and never displays arbitrary payload fields", () => {
    const event = { ...report, anonymizedAt: report.createdAt, payload: { ...report.payload, token: "MUST-NOT-RENDER" } } as unknown as AdminEvent;
    render(<ul><AdminEventRow event={event} unread={false} /></ul>);
    fireEvent.click(screen.getByRole("button", { name: "Open details: User message · account deleted" }));
    const dialog = screen.getByRole("dialog");
    expect(within(dialog).getByText("Account deleted. Personal details are unavailable.")).toBeTruthy();
    expect(within(dialog).queryByRole("link", { name: "Open account →" })).toBeNull();
    expect(within(dialog).queryByRole("button", { name: "Status / Reply" })).toBeNull();
    expect(document.body.textContent).not.toContain("MUST-NOT-RENDER");
    for (const personal of ["player@example.test", "Mobile chart cannot open", "Full support message details.", "account/one", "clerk-1", "/app/opponents", "/v1/opponents"]) expect(document.body.innerHTML).not.toContain(personal);
  });

  it("uses the deleted marker before download identity/browser fields, while retaining event type and time", () => {
    const event: AdminEvent = { eventId: "download-deleted", type: "agent_download", createdAt: report.createdAt, readAt: null, anonymizedAt: report.createdAt,
      payload: { platform: "windows", version: "0.20.0", channel: "private-channel", ip: "192.0.2.77", userAgent: "private-browser", referer: "private-referrer", country: "US" } };
    render(<ul><AdminEventRow event={event} unread={false} /></ul>);
    fireEvent.click(screen.getByRole("button", { name: "Open details: Agent download · account deleted" }));
    const dialog = screen.getByRole("dialog");
    expect(dialog.querySelector("time")?.getAttribute("datetime")).toBe(report.createdAt);
    for (const personal of ["192.0.2.77", "private-browser", "private-referrer", "private-channel"]) expect(document.body.textContent).not.toContain(personal);
  });
});
