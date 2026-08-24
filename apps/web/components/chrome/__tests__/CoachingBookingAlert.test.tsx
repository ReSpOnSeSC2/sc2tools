import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import type { ReactNode } from "react";

const harness = vi.hoisted(() => ({
  data: { eligible: false, unreadCount: 0, alert: null } as Record<string, unknown>,
  mutate: vi.fn(async () => undefined),
  socketHandlers: null as Record<string, (payload: unknown) => void> | null,
}));

vi.mock("next/link", () => ({
  default: ({ children, href, ...props }: { children: ReactNode; href: string }) => (
    <a href={href} {...props}>{children}</a>
  ),
}));
vi.mock("@/lib/clientApi", () => ({
  useApi: () => ({ data: harness.data, mutate: harness.mutate }),
}));
vi.mock("@/lib/useUserSocket", () => ({
  useUserSocket: (handlers: Record<string, (payload: unknown) => void> | null) => {
    harness.socketHandlers = handlers;
  },
}));
vi.mock("@/components/ui/Toast", () => ({
  useToastOptional: () => null,
}));

import { CoachingBookingAlert } from "../CoachingBookingAlert";

afterEach(() => {
  cleanup();
  harness.data = { eligible: false, unreadCount: 0, alert: null };
  harness.mutate.mockClear();
  harness.socketHandlers = null;
});

describe("CoachingBookingAlert", () => {
  it("stays absent for users without unread coaching events", () => {
    render(<CoachingBookingAlert />);
    expect(screen.queryByRole("link")).toBeNull();
  });

  it("deep-links an unread booking to the private Sessions view", () => {
    harness.data = {
      eligible: true,
      unreadCount: 2,
      alert: {
        kind: "booked",
        title: "New coaching booking",
        message: "Alex booked a session.",
        startAt: "2026-08-25T18:00:00.000Z",
      },
    };
    render(<CoachingBookingAlert />);

    const link = screen.getByRole("link", { name: /New coaching booking.*2 unread/i });
    expect(link.getAttribute("href")).toBe("/coaching?view=schedule");
    expect(link.textContent).toContain("2");
  });

  it("refreshes durable state after a realtime booking event", () => {
    harness.data = { eligible: true, unreadCount: 0, alert: null };
    render(<CoachingBookingAlert />);
    harness.socketHandlers?.["coaching:booking"]({});
    expect(harness.mutate).toHaveBeenCalledTimes(1);
  });
});
