import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

const harness = vi.hoisted(() => ({
  search: "",
  replace: vi.fn(),
  mutate: vi.fn(async () => undefined),
}));

vi.mock("next/navigation", () => ({
  useRouter: () => ({ replace: harness.replace }),
  useSearchParams: () => new URLSearchParams(harness.search),
}));
vi.mock("@/lib/clientApi", () => ({
  useApi: () => ({
    data: { role: "coach", coachId: "coach-1", studentId: null },
    error: undefined,
    isLoading: false,
    mutate: harness.mutate,
  }),
}));
vi.mock("./LockerHost", () => ({
  default: () => <div data-testid="locker-host">Locker content</div>,
}));
vi.mock("./CoachingSchedule", () => ({
  default: () => <div data-testid="sessions-view">Sessions content</div>,
}));

import CoachingWorkspace from "./CoachingWorkspace";

afterEach(() => {
  cleanup();
  harness.search = "";
  harness.replace.mockClear();
  harness.mutate.mockClear();
});

describe("CoachingWorkspace", () => {
  it("opens a direct Sessions link without eagerly mounting Locker", () => {
    harness.search = "view=schedule";
    render(<CoachingWorkspace />);

    expect(screen.getByTestId("sessions-view")).toBeTruthy();
    expect(screen.queryByTestId("locker-host")).toBeNull();
  });

  it("reacts when a same-page notification link changes the query", async () => {
    const view = render(<CoachingWorkspace />);
    expect(screen.getByTestId("locker-host")).toBeTruthy();

    harness.search = "view=schedule";
    view.rerender(<CoachingWorkspace />);

    await waitFor(() => expect(screen.getByTestId("sessions-view")).toBeTruthy());
    expect(screen.getByTestId("locker-host").parentElement?.getAttribute("aria-hidden")).toBe("true");
  });
});
