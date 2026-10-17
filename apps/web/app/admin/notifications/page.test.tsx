import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AdminEvent } from "../components/adminTypes";

const { useApiMock, socketMock, countsMutate } = vi.hoisted(() => ({
  useApiMock: vi.fn(),
  socketMock: vi.fn(),
  countsMutate: vi.fn(),
}));

vi.mock("@clerk/nextjs", () => ({ useAuth: () => ({ getToken: vi.fn() }) }));
vi.mock("@/lib/clientApi", () => ({
  useApi: (...args: unknown[]) => useApiMock(...args),
  apiCall: vi.fn(),
  API_BASE: "https://api.sc2tools.test",
}));
vi.mock("swr", () => ({
  default: () => ({ data: { unreadCount: 0 }, mutate: countsMutate }),
}));
vi.mock("../components/useAdminEventsSocket", () => ({
  useAdminEventsSocket: (...args: unknown[]) => socketMock(...args),
}));

import AdminNotificationsPage from "./page";

const installed: AdminEvent = {
  eventId: "installed-1", type: "agent_connected",
  payload: {
    userId: "user-1", clerkUserId: "clerk-1", email: "installed@example.com",
    deviceId: "device-1", platform: "windows", version: "0.18.9", source: "heartbeat",
  },
  createdAt: "2026-10-16T12:00:00.000Z", readAt: null,
};

function emit(event: AdminEvent) {
  const handler = socketMock.mock.calls.at(-1)?.[0] as (event: AdminEvent) => void;
  act(() => handler(event));
}

beforeEach(() => {
  vi.clearAllMocks();
  useApiMock.mockReturnValue({
    data: { items: [], nextBefore: null }, error: null, isLoading: false, mutate: vi.fn(),
  });
});
afterEach(cleanup);

describe("admin notification install activity", () => {
  it("renders a confirmed install received live in the All feed", () => {
    render(<AdminNotificationsPage />);

    emit(installed);

    expect(screen.getByText("Agent connected · Windows v0.18.9")).toBeTruthy();
    expect(screen.getByText("installed@example.com · confirmed by agent")).toBeTruthy();
    expect(countsMutate).toHaveBeenCalledOnce();
  });

  it("requests confirmed installs through the Installs filter", () => {
    useApiMock.mockImplementation((path: string) => ({
      data: { items: path.includes("type=agent_connected") ? [installed] : [], nextBefore: null },
      error: null, isLoading: false, mutate: vi.fn(),
    }));
    render(<AdminNotificationsPage />);

    fireEvent.click(screen.getByRole("button", { name: "Installs" }));

    expect(useApiMock).toHaveBeenLastCalledWith("/v1/admin/events?limit=50&type=agent_connected");
    expect(screen.getByText("installed@example.com · confirmed by agent")).toBeTruthy();
  });

  it("keeps live confirmed installs out of the Downloads filter", () => {
    render(<AdminNotificationsPage />);
    fireEvent.click(screen.getByRole("button", { name: "Downloads" }));

    emit(installed);

    expect(useApiMock).toHaveBeenLastCalledWith("/v1/admin/events?limit=50&type=agent_download");
    expect(screen.queryByText("Agent connected · Windows v0.18.9")).toBeNull();
  });
});
