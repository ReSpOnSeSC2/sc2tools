import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { GuideAdminStatusPayload } from "@/lib/guides/types";
import { ADMIN_VIDEOS, glaivesNote, statusFixture } from "./adminGuidesFixtures";

type Resp = { data?: unknown; error?: { status: number; message: string } };

const harness = vi.hoisted(() => ({
  responses: new Map<string, Resp>(),
  apiCall: vi.fn(),
  mutate: vi.fn(async () => undefined),
  getToken: vi.fn(async () => "admin-token"),
}));

vi.mock("@clerk/nextjs", () => ({ useAuth: () => ({ getToken: harness.getToken }) }));
vi.mock("@/lib/clientApi", () => ({
  useApi: (path: string) => {
    const r = harness.responses.get(path) ?? {};
    return { data: r.data, error: r.error, isLoading: false, mutate: harness.mutate };
  },
  apiCall: (...args: unknown[]) => harness.apiCall(...args),
}));

import AdminGuidesPage from "../page";

function serve(status: GuideAdminStatusPayload = statusFixture()) {
  harness.responses.set("/v1/admin/guides/notes", { data: { items: [glaivesNote()] } });
  harness.responses.set("/v1/admin/guides/status", { data: status });
  harness.responses.set("/v1/admin/guides/videos", { data: { items: ADMIN_VIDEOS } });
}

function expectPost(path: string, body?: object) {
  const init = body ? { method: "POST", body: JSON.stringify(body) } : { method: "POST" };
  return waitFor(() => expect(harness.apiCall).toHaveBeenCalledWith(harness.getToken, path, init));
}

beforeEach(() => {
  harness.responses.clear();
  harness.apiCall.mockResolvedValue({ started: true });
});
afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("admin Guides stats runs", () => {
  it("shows the last run's counts and the sample count", () => {
    serve();
    render(<AdminGuidesPage />);
    expect(screen.getByText("of 120 builds · 60 counters · 9 maps")).toBeTruthy();
    expect(screen.getByText("14")).toBeTruthy();
    expect(screen.getByText((5120).toLocaleString())).toBeTruthy();
  });

  it("starts a forced recompute with POST", async () => {
    serve();
    render(<AdminGuidesPage />);
    fireEvent.click(screen.getByRole("button", { name: "Recompute now" }));
    await expectPost("/v1/admin/guides/recompute");
    expect((await screen.findByRole("status")).textContent).toContain("Recompute started.");
  });

  it("explains a recompute switched off by the kill switch", async () => {
    serve();
    harness.apiCall.mockRejectedValue({ status: 409, code: "guide_stats_disabled", message: "That conflicts with another resource." });
    render(<AdminGuidesPage />);
    fireEvent.click(screen.getByRole("button", { name: "Recompute now" }));
    expect((await screen.findByRole("alert")).textContent).toContain("SC2TOOLS_GUIDE_STATS_DISABLED");
  });
});

describe("admin Guides samples backfill", () => {
  it("clamps the day window to 400 and starts the backfill", async () => {
    serve();
    render(<AdminGuidesPage />);
    const days = screen.getByLabelText("Days to backfill") as HTMLInputElement;
    expect(days.value).toBe("90");
    fireEvent.change(days, { target: { value: "999" } });
    fireEvent.blur(days);
    expect(days.value).toBe("400");
    fireEvent.click(screen.getByRole("button", { name: "Start backfill" }));
    await expectPost("/v1/admin/guides/backfill", { action: "start", days: 400 });
  });

  it("stops a running backfill and shows its progress", async () => {
    serve(statusFixture({ running: true, days: 30, startedAt: "2026-09-28T01:00:00.000Z", processed: 40, written: 31, skipped: 8, failed: 1 }));
    render(<AdminGuidesPage />);
    expect(screen.getByText("Running over the last 30 days: 40 games processed, 31 samples written, 8 skipped, 1 failed.")).toBeTruthy();
    expect((screen.getByRole("button", { name: "Start backfill" }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(screen.getByRole("button", { name: "Stop" }));
    await expectPost("/v1/admin/guides/backfill", { action: "stop" });
    // Stop sits inside the start form: it must not also submit a start.
    expect(harness.apiCall).toHaveBeenCalledTimes(1);
  });

  it("disables start when the backfill is switched off on the server", () => {
    serve(statusFixture({ disabled: true }));
    render(<AdminGuidesPage />);
    expect((screen.getByRole("button", { name: "Start backfill" }) as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByText(/Switched off on this server/)).toBeTruthy();
  });
});
