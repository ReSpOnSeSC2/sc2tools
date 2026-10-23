import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SettingsImportPanel } from "../SettingsImportPanel";
import { ToastProvider } from "@/components/ui/Toast";

const h = vi.hoisted(() => ({ apiCall: vi.fn(), me: { data: {} as object, mutate: vi.fn() }, jobs: { data: { items: [] as object[] }, error: undefined as Error | undefined, mutate: vi.fn() }, progress: { job: null, active: false, pct: 0, etaSeconds: null, isLoading: false, refresh: vi.fn() } }));
vi.mock("@clerk/nextjs", () => ({ useAuth: () => ({ getToken: async () => "token" }) }));
vi.mock("@/lib/clientApi", () => ({ apiCall: (...args: unknown[]) => h.apiCall(...args), useApi: (path: string) => path === "/v1/me" ? h.me : h.jobs }));
vi.mock("@/components/imports/useImportStatus", async (original) => ({ ...await original<object>(), useImportStatus: () => h.progress }));
beforeEach(() => {
  vi.useFakeTimers(); h.apiCall.mockReset(); h.apiCall.mockResolvedValue({});
  h.me = { data: { userId: "u1", agentPaired: true, agentLastSeenAt: new Date().toISOString() }, mutate: vi.fn() };
  h.jobs = { data: { items: [] }, error: undefined, mutate: vi.fn().mockResolvedValue({}) };
  h.progress.refresh.mockReset();
});
afterEach(() => { cleanup(); vi.useRealTimers(); });
function show() { return render(<ToastProvider><SettingsImportPanel /></ToastProvider>); }

describe("desktop import controls", () => {
  it("starts an actual agent command only while the PC is online", async () => {
    show(); await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Start full import" })); });
    expect(h.apiCall.mock.calls[0]).toMatchObject([expect.any(Function), "/v1/import/start", { method: "POST", body: "{}" }]);
    expect(h.progress.refresh).toHaveBeenCalledTimes(1);
    await act(async () => { vi.advanceTimersByTime(180001); });
    expect((screen.getByRole("button", { name: "Start full import" }) as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByText(/PC is offline/)).toBeTruthy();
  });
  it("offers pairing instead of sending commands without a paired PC", () => {
    h.me.data = { userId: "u1", agentPaired: false }; show();
    expect(screen.getByRole("link", { name: "Pair a PC" }).getAttribute("href")).toBe("/devices");
    expect((screen.getByRole("button", { name: "Start full import" }) as HTMLButtonElement).disabled).toBe(true);
  });
  it("shows only ten jobs, measured duration and readable exclusion reasons", () => {
    h.jobs.data.items = Array.from({ length: 12 }, (_, i) => ({ jobId: String(i), status: "done", completed: 100 + i, total: 200 + i, startedAt: new Date(Date.now() - 3600000).toISOString(), finishedAt: new Date(Date.now() - 3360000).toISOString(), errorBreakdown: i === 0 ? { parse_failed: 2 } : {} }));
    show(); expect(screen.getAllByText(/took 4 min/)).toHaveLength(10);
    expect(screen.getByText("Files that couldn't be imported")).toBeTruthy();
    expect(screen.getByText(/File looks corrupt/)).toBeTruthy();
  });
  it("keeps previous jobs visible while offering Retry for their source", () => {
    h.jobs.data.items = [{ jobId: "j", status: "done", completed: 3, total: 3 }]; h.jobs.error = new Error("offline");
    show(); expect(screen.getByText("3/3")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Try again" })); expect(h.jobs.mutate).toHaveBeenCalledTimes(1);
    expect(screen.queryByText("No previous imports")).toBeNull();
  });
});
