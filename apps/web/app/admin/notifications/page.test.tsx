import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AdminEvent } from "../components/adminTypes";
import { navigation } from "../components/__tests__/navigationFixture";
vi.mock("next/navigation", () => import("../components/__tests__/navigationFixture"));

const { useApiMock, socketMock, countsMutate, feedMutate, apiCallMock, scenario, auth } = vi.hoisted(() => ({
  useApiMock: vi.fn(), socketMock: vi.fn(), countsMutate: vi.fn(), feedMutate: vi.fn(), apiCallMock: vi.fn(),
  scenario: { items: [] as AdminEvent[], unreadCount: 0 },
  auth: { userId: "admin-a", getToken: vi.fn() },
}));

vi.mock("@clerk/nextjs", () => ({ useAuth: () => auth }));
vi.mock("@/lib/clientApi", () => ({
  useApi: (...args: unknown[]) => useApiMock(...args), apiCall: (...args: unknown[]) => apiCallMock(...args),
  API_BASE: "https://api.sc2tools.test",
}));
vi.mock("../components/useAdminEventsSocket", () => ({
  useAdminEventsSocket: (...args: unknown[]) => socketMock(...args),
}));

import AdminNotificationsPage from "./page";

const installed: AdminEvent = {
  eventId: "installed-1", type: "agent_connected",
  payload: { userId: "user-1", clerkUserId: "clerk-1", email: "installed@example.com",
    deviceId: "device-1", platform: "windows", version: "0.18.9", source: "heartbeat" },
  createdAt: "2026-10-16T12:00:00.000Z", readAt: null,
};
const CURSOR = "opaque:cursor+/=";
function emit(event: AdminEvent) {
  const handler = socketMock.mock.calls.at(-1)?.[0] as (event: AdminEvent) => void;
  act(() => handler(event));
}
function lastFeedPath(): string {
  return useApiMock.mock.calls.filter(([path]) => path.startsWith("/v1/admin/events?")).at(-1)?.[0];
}
function message(index: number, readAt: string | null = null): AdminEvent {
  return { eventId: `message-${index}`, type: "user_message", readAt,
    createdAt: "2026-10-17T12:00:00Z",
    payload: { userId: null, clerkUserId: null, email: "reporter@example.com", subject: `Report ${index}`, message: "Details" } };
}

beforeEach(() => {
  navigation.url = "/admin/notifications";
  vi.clearAllMocks();
  scenario.items = [];
  scenario.unreadCount = 0;
  auth.userId = "admin-a";
  countsMutate.mockResolvedValue(undefined);
  feedMutate.mockResolvedValue(undefined);
  apiCallMock.mockResolvedValue({ markedRead: 1 });
  useApiMock.mockImplementation((path: string) => {
    if (path === "/v1/admin/events/counts") return { data: { unreadCount: scenario.unreadCount }, mutate: countsMutate };
    const params = new URL(path, "https://api.sc2tools.test").searchParams;
    const eligible = scenario.items.filter((event) =>
      (params.get("unread") !== "true" || !event.readAt) &&
      (!params.has("type") || event.type === params.get("type")));
    const start = params.get("before") ? 50 : 0;
    return { data: { items: eligible.slice(start, start + 50), nextBefore: eligible.length > start + 50 ? CURSOR : null },
      error: null, isLoading: false, mutate: feedMutate };
  });
});
afterEach(cleanup);

describe("admin unread activity", () => {
  it("opens in server-filtered Unread so an older install behind 50 read events is visible", () => {
    scenario.items = [...Array.from({ length: 50 }, (_, index) => message(index, "2026-10-17T13:00:00Z")), installed];
    scenario.unreadCount = 1;
    render(<AdminNotificationsPage />);
    expect(lastFeedPath()).toBe("/v1/admin/events?limit=50&unread=true");
    expect(screen.getByText("installed@example.com · confirmed by agent")).toBeTruthy();
    expect(screen.getByText("1 unread across all activity.")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "All activity" }));
    expect(screen.queryByText("installed@example.com · confirmed by agent")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Unread" }));
    expect(screen.getByText("installed@example.com · confirmed by agent")).toBeTruthy();
  });

  it("paginates unread records with the server cursor and resets pagination for a type change", () => {
    scenario.items = Array.from({ length: 61 }, (_, index) => message(index));
    scenario.unreadCount = 61;
    render(<AdminNotificationsPage />);
    fireEvent.click(screen.getByRole("button", { name: "Next" }));
    expect(lastFeedPath()).toContain(`before=${encodeURIComponent(CURSOR)}`);
    expect(screen.getByText("Report 60")).toBeTruthy();
    expect(screen.queryByText("Report 0")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Messages" }));
    expect(lastFeedPath()).toBe("/v1/admin/events?limit=50&unread=true&type=user_message");
    expect(screen.getByText("Report 0")).toBeTruthy();
  });

  it("explains an empty type filter and links back to all counted unread activity", () => {
    scenario.items = [installed];
    scenario.unreadCount = 9;
    render(<AdminNotificationsPage />);
    fireEvent.click(screen.getByRole("button", { name: "Messages" }));
    expect(screen.getByText("No unread messages in this filter.")).toBeTruthy();
    expect(screen.getByText("9 unread across all activity.")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Mark all 9 unread as read" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "View all 9 unread notifications" }));
    expect(screen.getByText("installed@example.com · confirmed by agent")).toBeTruthy();
  });

  it("returns from an emptied older page to unread activity still present on the first page", () => {
    scenario.items = Array.from({ length: 61 }, (_, index) => message(index));
    scenario.unreadCount = 61;
    const { rerender } = render(<AdminNotificationsPage />);
    fireEvent.click(screen.getByRole("button", { name: "Next" }));
    scenario.items = [message(0)];
    scenario.unreadCount = 1;
    rerender(<AdminNotificationsPage />);
    expect(screen.getByText("No unread notifications on this page.")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "View all 1 unread notifications" }));
    expect(screen.getByText("Report 0")).toBeTruthy();
    expect(lastFeedPath()).not.toContain("before=");
  });

  it("refreshes rows and global counts even when the incoming type is filtered out", () => {
    scenario.items = [installed];
    render(<AdminNotificationsPage />);
    emit(installed);
    expect(screen.getByText("Agent connected · Windows v0.18.9")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Downloads" }));
    emit(installed);
    expect(screen.queryByText("Agent connected · Windows v0.18.9")).toBeNull();
    expect(countsMutate).toHaveBeenCalledTimes(2);
    expect(feedMutate).toHaveBeenCalledTimes(2);
  });

  it("polls both resources and refreshes missed activity on socket connect/reconnect", () => {
    render(<AdminNotificationsPage />);
    expect(useApiMock).toHaveBeenCalledWith("/v1/admin/events?limit=50&unread=true", { refreshInterval: 60000, keepPreviousData: true });
    expect(useApiMock).toHaveBeenCalledWith("/v1/admin/events/counts", { refreshInterval: 60000, keepPreviousData: true });
    const connected = socketMock.mock.calls.at(-1)?.[1] as () => void;
    act(() => { connected(); connected(); });
    expect(feedMutate).toHaveBeenCalledTimes(2);
    expect(countsMutate).toHaveBeenCalledTimes(2);
  });

  it("refreshes unread rows after mark-all-read and ignores a delayed pre-read socket event", async () => {
    scenario.items = [installed];
    scenario.unreadCount = 1;
    apiCallMock.mockImplementation(async () => {
      scenario.unreadCount = 0;
      scenario.items = [{ ...installed, readAt: "2026-10-17T13:00:00Z" }];
      return { markedRead: 1 };
    });
    render(<AdminNotificationsPage />);
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Mark all 1 unread as read" })); });
    expect(screen.queryByText("installed@example.com · confirmed by agent")).toBeNull();
    expect(screen.getByText("No unread notifications.")).toBeTruthy();
    expect(feedMutate).toHaveBeenCalledOnce();
    emit(installed);
    expect(screen.queryByText("installed@example.com · confirmed by agent")).toBeNull();
  });

  it("drops a previously delivered row when a poll sees another tab's mark-all-read", () => {
    scenario.items = [installed];
    scenario.unreadCount = 1;
    const { rerender } = render(<AdminNotificationsPage />);
    emit(installed);
    scenario.items = [];
    scenario.unreadCount = 0;
    rerender(<AdminNotificationsPage />);
    expect(screen.queryByText("installed@example.com · confirmed by agent")).toBeNull();
    expect(screen.getByText("No unread notifications.")).toBeTruthy();
  });

  it("does not skip the boundary record when live activity arrives before Older is clicked", async () => {
    const initial = Array.from({ length: 51 }, (_, index) => message(index));
    let serverRows = initial;
    let firstPage = initial.slice(0, 50);
    let validating = false;
    let finishRefresh: () => void = () => {};
    feedMutate.mockImplementation(() => {
      validating = true;
      return new Promise<void>((resolve) => {
        finishRefresh = () => { firstPage = serverRows.slice(0, 50); validating = false; resolve(); };
      });
    });
    useApiMock.mockImplementation((path: string) => {
      if (path.endsWith("/counts")) return { data: { unreadCount: serverRows.length }, mutate: countsMutate };
      const before = new URL(path, "https://api.sc2tools.test").searchParams.get("before");
      const start = before ? serverRows.findIndex((row) => row.eventId === before) + 1 : 0;
      const items = before ? serverRows.slice(start, start + 50) : firstPage;
      return { data: { items, nextBefore: before ? null : items.at(-1)?.eventId },
        isLoading: false, isValidating: validating, mutate: feedMutate };
    });
    const { rerender } = render(<AdminNotificationsPage />);
    const incoming = message(100);
    serverRows = [incoming, ...initial];
    emit(incoming);
    rerender(<AdminNotificationsPage />);
    expect(screen.getByRole("button", { name: "Next" }).hasAttribute("disabled")).toBe(true);
    await act(async () => { finishRefresh(); });
    rerender(<AdminNotificationsPage />);
    fireEvent.click(screen.getByRole("button", { name: "Next" }));
    expect(screen.getByText("Report 49")).toBeTruthy();
    expect(screen.getByText("Report 50")).toBeTruthy();
  });
});

describe("admin backup alerts", () => {
  it("has a Backups filter for overdue-snapshot alerts", () => {
    const overdue: AdminEvent = {
      eventId: "backup-1", type: "backup_stale", readAt: null, createdAt: "2026-10-18T12:00:00Z",
      payload: { reason: "stale", lastSnapshotAt: "2026-10-16T08:00:00Z", ageHours: 52, latestStatus: "completed" },
    };
    scenario.items = [installed, overdue];
    scenario.unreadCount = 2;
    render(<AdminNotificationsPage />);
    fireEvent.click(screen.getByRole("button", { name: "Backups" }));
    expect(lastFeedPath()).toBe("/v1/admin/events?limit=50&unread=true&type=backup_stale");
    expect(screen.getByText("Database backup is overdue")).toBeTruthy();
    expect(screen.queryByText("installed@example.com · confirmed by agent")).toBeNull();
  });
});
