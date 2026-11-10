import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { loadLazyHelpLink } from "@/components/help/__tests__/loadLazyHelpLink";
import { ReanalysisCard } from "../ReanalysisCard";

const fixture = vi.hoisted(() => ({
  data: undefined as unknown,
  isLoading: false,
  error: null as unknown,
  mutate: vi.fn(async (..._args: unknown[]) => undefined as unknown),
  apiCall: vi.fn(async (..._args: unknown[]) => ({}) as unknown),
  handlers: null as Record<string, (payload: unknown) => void> | null,
}));

vi.mock("@clerk/nextjs", () => ({ useAuth: () => ({ getToken: async () => "synthetic", userId: "synthetic-owner", isLoaded: true, isSignedIn: true }) }));
vi.mock("@/lib/clientApi", async (original) => ({
  ...(await original<typeof import("@/lib/clientApi")>()),
  useApi: () => ({ data: fixture.data, isLoading: fixture.isLoading, error: fixture.error, mutate: fixture.mutate }),
  apiCall: (...args: unknown[]) => fixture.apiCall(...args),
}));
vi.mock("@/lib/useUserSocket", () => ({ useUserSocket: (handlers: Record<string, (payload: unknown) => void> | null) => { fixture.handlers = handlers; } }));

beforeAll(loadLazyHelpLink, 20_000);
afterEach(() => {
  cleanup();
  fixture.data = undefined; fixture.isLoading = false; fixture.error = null; fixture.handlers = null;
  fixture.mutate.mockClear(); fixture.apiCall.mockReset(); fixture.apiCall.mockResolvedValue({});
});

const COHORTS = [
  { id: "engine-before:1.6.10", kind: "engine", engine: "1.6.10", date: "2026-10-10", summary: "PvT Blink labels need Blink first.", matchups: ["PvT", "TvP"], count: 1200, unknown: 30 },
  { id: "engine-before:1.6.11", kind: "engine", engine: "1.6.11", date: "2026-10-14", summary: "Oracle-first openings keep their label.", matchups: ["PvT", "TvP"], count: 1500, unknown: 30 },
  { id: "missing-macro", kind: "macro", count: 0 },
  { id: "no-engine-stamp", kind: "engine-unknown", count: 42 },
];
const JOB = { id: "a".repeat(24), cohortId: "engine-before:1.6.11", engine: "1.6.11", status: "running", total: 1500, processed: 300,
  updated: 280, unavailable: 15, failed: 5, etaSec: 7260, createdAt: "2026-11-10T12:00:00.000Z", completedAt: null };

function overview(changes: Record<string, unknown> = {}) {
  return { catalogRevision: "0123456789abcdef", cohorts: COHORTS, job: null, agent: "ready", ...changes };
}

describe("ReanalysisCard", () => {
  it("shows a loading state before counts arrive", () => {
    fixture.isLoading = true;
    render(<ReanalysisCard />);
    expect(screen.getByRole("status").textContent).toContain("Counting games");
    expect(document.getElementById("reanalyze")?.tagName).toBe("SECTION");
  });

  it("lists cohorts with what changed, the stats note, and starts the chosen one", async () => {
    fixture.data = overview();
    render(<ReanalysisCard />);
    expect(screen.getByText("Analyzed before engine 1.6.10")).toBeTruthy();
    expect(screen.getByText(/1,200 games/)).toBeTruthy();
    expect(screen.getByText(/What changed: PvT Blink labels need Blink first\./)).toBeTruthy();
    expect(screen.getByText(/PvT and TvP games · engine change from Oct 10, 2026/)).toBeTruthy();
    expect(screen.getAllByText(/30 more in these matchups have no engine version/)).toHaveLength(2);
    expect(screen.getByText(/Historical stats will change/)).toBeTruthy();
    const macro = screen.getByRole("radio", { name: /Missing a macro score/ }) as HTMLInputElement;
    expect(macro.disabled).toBe(true);
    fireEvent.click(screen.getByRole("radio", { name: /Analyzed before engine 1\.6\.11/ }));
    fireEvent.click(screen.getByRole("button", { name: "Start re-analysis" }));
    await waitFor(() => expect(fixture.apiCall).toHaveBeenCalledTimes(1));
    const [, path, init] = fixture.apiCall.mock.calls[0] as unknown as [unknown, string, RequestInit];
    expect(path).toBe("/v1/me/reanalysis");
    expect(JSON.parse(String(init.body))).toEqual({ cohortId: "engine-before:1.6.11" });
    await waitFor(() => expect(fixture.mutate).toHaveBeenCalled());
    expect(fixture.handlers).toBeNull();
  });

  it("says when nothing needs re-analysis and hides Start", () => {
    fixture.data = overview({ cohorts: COHORTS.map((cohort) => ({ ...cohort, count: 0 })) });
    render(<ReanalysisCard />);
    expect(screen.getByText(/Nothing to re-analyze/)).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Start re-analysis" })).toBeNull();
  });

  it("shows progress with time left and pauses or cancels the job", async () => {
    fixture.data = overview({ job: JOB });
    render(<ReanalysisCard />);
    const bar = screen.getByRole("progressbar", { name: "Re-analysis progress" });
    expect(bar.getAttribute("aria-valuenow")).toBe("300");
    expect(bar.getAttribute("aria-valuemax")).toBe("1500");
    expect(screen.getByText(/Re-analyzing 300 of 1,500 games · about 2 h 1 min left\./)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Pause" }));
    await waitFor(() => expect(fixture.apiCall).toHaveBeenCalledTimes(1));
    expect(fixture.apiCall.mock.calls[0][1]).toBe("/v1/me/reanalysis/pause");
    expect(JSON.parse(String((fixture.apiCall.mock.calls[0] as unknown as [unknown, string, RequestInit])[2].body))).toEqual({ jobId: JOB.id });
    await waitFor(() => expect(screen.getByRole("button", { name: "Cancel re-analysis" }).hasAttribute("disabled")).toBe(false));
    fireEvent.click(screen.getByRole("button", { name: "Cancel re-analysis" }));
    await waitFor(() => expect(fixture.apiCall.mock.calls.at(-1)?.[1]).toBe("/v1/me/reanalysis/cancel"));
  });

  it("applies pushed progress locally and refreshes counts once the job ends", async () => {
    fixture.data = overview({ job: JOB });
    render(<ReanalysisCard />);
    expect(fixture.handlers).not.toBeNull();
    fixture.handlers!["reanalysis:progress"]({ ...JOB, processed: 301 });
    expect(fixture.mutate).toHaveBeenCalledTimes(1);
    const [update, options] = fixture.mutate.mock.calls[0] as unknown as [(current: unknown) => { job: { processed: number } }, { revalidate: boolean }];
    expect(options).toEqual({ revalidate: false });
    expect(update(overview({ job: JOB })).job.processed).toBe(301);
    fixture.handlers!["reanalysis:progress"]({ ...JOB, status: "completed", processed: 1500 });
    expect(fixture.mutate).toHaveBeenCalledTimes(3);
  });

  it("resumes a paused job and explains an offline agent", () => {
    fixture.data = overview({ job: { ...JOB, status: "paused", etaSec: null }, agent: "offline" });
    render(<ReanalysisCard />);
    expect(screen.getByText(/Paused at 300 of 1,500 games\./)).toBeTruthy();
    expect(screen.getByRole("button", { name: "Resume" })).toBeTruthy();
    expect(screen.getByText(/desktop agent is offline\. Re-analysis continues when it reconnects/)).toBeTruthy();
  });

  it("asks for an agent update when the connected agent is too old", () => {
    fixture.data = overview({ agent: "update_required" });
    render(<ReanalysisCard />);
    expect(screen.getByText(/Update your desktop agent to re-analyze games/)).toBeTruthy();
    expect(screen.getByRole("link", { name: "Get the update" }).getAttribute("href")).toBe("/download");
  });

  it("explains a refused start in plain words", async () => {
    fixture.data = overview();
    fixture.apiCall.mockRejectedValue({ status: 409, code: "reanalysis_job_active", message: "conflict" });
    render(<ReanalysisCard />);
    fireEvent.click(screen.getByRole("button", { name: "Start re-analysis" }));
    expect((await screen.findByRole("alert")).textContent).toBe("A re-analysis is already running. Pause or cancel it first.");
  });

  it("summarizes the last finished run", () => {
    fixture.data = overview({ job: { ...JOB, status: "completed", processed: 1500, updated: 1480, unavailable: 15, failed: 5, etaSec: null } });
    render(<ReanalysisCard />);
    expect(screen.getByText(/1,480 updated, 15 without a replay file, 5 failed\./)).toBeTruthy();
  });
});
