import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { useState } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

const harness = vi.hoisted(() => ({
  role: "coach",
  search: "",
  replace: vi.fn(),
  mutate: vi.fn(async () => undefined),
  loading: false,
  authLoaded: true,
  relationships: [] as Array<{ student: { id: string; name: string }; coach: { id: string; name: string }; status: string }>,
}));
vi.mock("@clerk/nextjs", () => ({ useAuth: () => ({ isLoaded: harness.authLoaded, isSignedIn: true }), RedirectToSignIn: () => null }));

vi.mock("next/navigation", () => ({
  useRouter: () => ({ replace: harness.replace }),
  useSearchParams: () => new URLSearchParams(harness.search),
}));
vi.mock("@/lib/clientApi", () => ({
  useApi: (path: string) => ({
    data: path === "/v1/coaching/practice-sharing" ? { relationships: harness.relationships } : path === "/v1/coaching/alerts" ? { unreadCount: 2 } : harness.loading ? undefined : { role: harness.role, coachId: harness.role === "coach" ? "coach-1" : null, studentId: null },
    error: undefined,
    isLoading: harness.loading,
    mutate: harness.mutate,
  }),
}));
vi.mock("./LockerHost", () => ({
  default: () => <div data-testid="locker-host">Locker content</div>,
}));
vi.mock("./CoachingSchedule", () => ({
  default: function ScheduleMock({ onDirtyChange }: { onDirtyChange?: (value: boolean) => void }) {
    const [draft, setDraft] = useState("");
    return <div data-testid="sessions-view"><input aria-label="Availability draft" value={draft} onChange={(event) => { setDraft(event.target.value); onDirtyChange?.(true); }} /></div>;
  },
}));
vi.mock("./CoachingPractice", () => ({
  default: ({ role }: { role: string }) => (
    <div data-testid="practice-view" data-role={role}>
      Practice content
    </div>
  ),
}));

import CoachingWorkspace from "./CoachingWorkspace";
import CoachingPage from "./page";

afterEach(() => {
  cleanup();
  harness.role = "coach";
  harness.search = "";
  harness.replace.mockClear();
  harness.mutate.mockClear();
  harness.loading = false; harness.authLoaded = true; harness.relationships = [];
});

describe("CoachingWorkspace", () => {
  it("opens a direct Practice link without eagerly mounting Locker", () => {
    harness.search = "view=practice";
    render(<CoachingWorkspace />);

    expect(screen.getByTestId("practice-view").getAttribute("data-role")).toBe(
      "coach",
    );
    expect(screen.queryByTestId("locker-host")).toBeNull();
    expect(
      screen.getByRole("tab", { name: "Practice" }).getAttribute(
        "aria-selected",
      ),
    ).toBe("true");
  });

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
    expect(screen.getByTestId("locker-host").parentElement?.hidden).toBe(true);
  });

  it("links the guide from the visible page header", async () => {
    render(<CoachingWorkspace />);
    const help = await screen.findByRole("link", { name: "How coaching works" });
    expect(help.getAttribute("href")).toBe("/help/coaching");
    expect(screen.getByRole("heading", { name: "Coaching Coach" })).toBeTruthy();
    expect(screen.getByRole("tablist", { name: "Coaching workspace" }).contains(help)).toBe(false);
  });

  it("explains the invite-only screen to an account no coach has attached", async () => {
    harness.role = "none";
    render(<CoachingWorkspace />);
    expect(screen.getByRole("heading", { name: "Private coaching" })).toBeTruthy();
    const help = await screen.findByRole("link", { name: "How coaching access works" });
    expect(help.getAttribute("href")).toBe("/help/coaching#roles-and-linking");
    expect(screen.queryByRole("tablist", { name: "Coaching workspace" })).toBeNull();
  });

  it("shows a real shell while Clerk or workspace access loads", () => {
    harness.authLoaded = false;
    const view = render(<CoachingPage />);
    expect(screen.getByRole("region", { name: "Loading coaching workspace" }).getAttribute("aria-busy")).toBe("true");
    harness.authLoaded = true; harness.loading = true; view.rerender(<CoachingPage />);
    expect(screen.getByRole("region", { name: "Loading coaching workspace" })).toBeTruthy();
  });

  it("names the student's coach and pending sharing request, and uses arrow navigation", () => {
    harness.role = "student";
    harness.relationships = [{ student: { id: "student-1", name: "Player" }, coach: { id: "coach-1", name: "Coach Jay" }, status: "pending" }];
    render(<CoachingWorkspace />);
    expect(screen.getByRole("heading", { name: "Coaching Student" })).toBeTruthy();
    expect(screen.getByText("with Coach Jay")).toBeTruthy();
    const locker = screen.getByRole("tab", { name: "Locker" }); locker.focus();
    fireEvent.keyDown(locker, { key: "ArrowRight" });
    const practice = screen.getByRole("tab", { name: "Practice 1 practice-sharing request waiting" });
    expect(document.activeElement).toBe(practice);
    expect(harness.replace).toHaveBeenCalledWith("/coaching?view=practice", { scroll: false });
  });

  it("keeps an activated sessions draft across Locker and Practice visits, with a warning dot", () => {
    harness.search = "view=schedule"; render(<CoachingWorkspace />);
    const input = screen.getByRole("textbox", { name: "Availability draft" }) as HTMLInputElement;
    fireEvent.change(input, { target: { value: "Monday 10:00" } });
    expect(screen.getByRole("tab", { name: /Sessions.*Unpublished availability changes/ })).toBeTruthy();
    fireEvent.click(screen.getByRole("tab", { name: "Locker" }));
    expect(screen.getByTestId("sessions-view").contains(input)).toBe(true);
    fireEvent.click(screen.getByRole("tab", { name: "Practice" }));
    fireEvent.click(screen.getByRole("tab", { name: /Sessions/ }));
    expect(screen.getByRole("textbox", { name: "Availability draft" })).toBe(input);
    expect(input.value).toBe("Monday 10:00");
  });
});
