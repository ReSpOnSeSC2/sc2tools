import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import AdminModerationPage from "./page";

const mocks = vi.hoisted(() => ({ data: { items: [] as unknown[], total: 0, capped: false }, mutate: vi.fn(), call: vi.fn(), toast: vi.fn() }));
vi.mock("@clerk/nextjs", () => ({ useAuth: () => ({ getToken: vi.fn() }) }));
vi.mock("@/lib/clientApi", () => ({ useApi: () => ({ data: mocks.data, mutate: mocks.mutate }), apiCall: mocks.call }));
vi.mock("@/components/ui/Toast", () => ({ useToastOptional: () => ({ toast: { success: mocks.toast } }) }));
const report = (id: string, targetId = "build-a", reason = "spam") => ({ id, reporterUserId: `user-${id}`, targetId, targetType: "build", reason, createdAt: "2026-10-01T00:00:00Z", target: { title: targetId, snippet: "Expand first" } });
beforeEach(() => { mocks.data = { items: [report("1"), report("2"), report("3", "build-a", "abuse"), report("4", "build-b")], total: 4, capped: false }; mocks.call.mockReset(); mocks.call.mockResolvedValue(undefined); mocks.mutate.mockClear(); mocks.toast.mockClear(); });
afterEach(cleanup);

describe("moderation queue", () => {
  it("sorts groups by their newest report and keeps missing targets dismissible", async () => {
    mocks.data.items = [report("1"), { ...report("2"), createdAt: "2026-10-20T00:00:00Z" }, { ...report("3", "build-b"), createdAt: "2026-10-10T00:00:00Z", target: null }];
    render(<AdminModerationPage />);
    fireEvent.change(screen.getByLabelText("Sort reports"), { target: { value: "newest" } });
    expect(screen.getAllByRole("heading", { level: 2 }).map((heading) => heading.textContent)).toEqual(["build-a", "build-b"]);
    expect(screen.getByText("Target no longer exists")).toBeTruthy();
    expect(screen.getAllByRole("link", { name: /Open in context/ })).toHaveLength(1);
    fireEvent.click(screen.getAllByRole("button", { name: "Dismiss" })[1]);
    await waitFor(() => expect(mocks.call).toHaveBeenCalledWith(expect.anything(), "/v1/community/admin/reports/3", expect.anything()));
  });
  it("groups reports with reason tallies, context links and a confirmation before removal", async () => {
    render(<AdminModerationPage />);
    expect(screen.getByText(/3 reports · spam ×2, abuse ×1/)).toBeTruthy();
    expect(screen.getAllByRole("button", { name: "Remove target" })).toHaveLength(2);
    fireEvent.click(screen.getAllByRole("button", { name: "Remove target" })[0]);
    const dialog = screen.getByRole("dialog", { name: "Remove this build?" });
    expect(mocks.call).not.toHaveBeenCalled();
    fireEvent.change(within(dialog).getByRole("textbox", { name: "Resolution note (optional)" }), { target: { value: "Verified spam" } });
    fireEvent.click(within(dialog).getByRole("button", { name: "Remove" }));
    await waitFor(() => expect(mocks.call).toHaveBeenCalled());
    expect(JSON.parse(mocks.call.mock.calls[0][2].body)).toEqual({ action: "remove", note: "Verified spam" });
    expect(screen.getAllByRole("link", { name: /Open in context/ })[0].getAttribute("href")).toBe("/community/builds/build-a");
  });

  it("keeps other cards usable while one is busy and retries the failed action and note", async () => {
    let reject!: (error: unknown) => void;
    mocks.call.mockReturnValueOnce(new Promise((_, no) => { reject = no; }));
    render(<AdminModerationPage />);
    fireEvent.click(screen.getAllByRole("button", { name: "Dismiss" })[0]);
    expect(screen.getAllByRole("button", { name: "Dismiss" })[0].getAttribute("aria-busy")).toBe("true");
    expect((screen.getAllByRole("button", { name: "Dismiss" })[1] as HTMLButtonElement).disabled).toBe(false);
    reject({ status: 500, message: "Try later", requestId: "ref-123" });
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toContain("Error ID ref-123");
    fireEvent.click(within(alert).getByRole("button", { name: "Retry" }));
    await waitFor(() => expect(mocks.call).toHaveBeenCalledTimes(2));
    expect(mocks.call.mock.calls[1][2].body).toBe(mocks.call.mock.calls[0][2].body);
  });

  it("treats already-resolved reports as success", async () => {
    mocks.call.mockRejectedValueOnce({ status: 404, code: "report_not_found", message: "Already resolved" });
    render(<AdminModerationPage />);
    fireEvent.click(screen.getAllByRole("button", { name: "Dismiss" })[0]);
    await waitFor(() => expect(mocks.toast).toHaveBeenCalledWith("Already resolved"));
    expect(mocks.mutate).toHaveBeenCalled();
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("shows the cap and a clear empty state", () => {
    mocks.data = { items: [], total: 123, capped: true };
    render(<AdminModerationPage />);
    expect(screen.getByText("Showing the oldest 100 of 123 open reports. Resolve these to see the rest.")).toBeTruthy();
    expect(screen.getByText("Queue clear")).toBeTruthy();
  });
});
