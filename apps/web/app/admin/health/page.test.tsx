import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import AdminHealthPage from "./page";
import { StatusTile } from "../components/StatusTile";
const mocks = vi.hoisted(() => ({ healthRetry: vi.fn(), infrastructureRetry: vi.fn(),
  data: null as Record<string, unknown> | null,
  error: { status: 500, message: "Probe unavailable", requestId: "health-ref" } as { status: number; message: string; requestId: string } | null,
  requests: [] as { path: string; interval: number | undefined }[],
}));
vi.mock("@/lib/clientApi", () => ({ useApi: (path: string, options?: { refreshInterval?: number }) => {
  mocks.requests.push({ path, interval: options?.refreshInterval });
  return path.endsWith("/health")
    ? { error: mocks.error, data: mocks.data, mutate: mocks.healthRetry }
    : { error: null, data: { asOf: "2026-10-01" }, mutate: mocks.infrastructureRetry };
} }));
vi.mock("../components/InfrastructureOverview", () => ({ InfrastructureOverview: () => <div>Provider capacity still visible</div> }));
vi.mock("../components/BackgroundJobs", () => ({ BackgroundJobs: () => <div>Background jobs still visible</div> }));
vi.mock("../components/DatabaseBackupsCard", () => ({ DatabaseBackupsCard: () => <div>Database backups still visible</div> }));
beforeEach(() => {
  mocks.healthRetry.mockClear(); mocks.infrastructureRetry.mockClear(); mocks.requests.length = 0;
  mocks.data = null; mocks.error = { status: 500, message: "Probe unavailable", requestId: "health-ref" };
});
afterEach(cleanup);

function health(snapshot?: unknown) {
  return { personalChartCache: snapshot, mongo: { ok: true, latencyMs: 2, error: null },
    runtime: { replayFilesStore: "r2", gameDetailsStore: "mongo", nodeVersion: "fixture" },
    uptime: { uptimeSeconds: 60, startedAt: "2026-10-01T00:00:00Z" } };
}
describe("independent infrastructure states", () => {
  it("keeps the header, provider section and backups during a failed health probe", () => {
    render(<AdminHealthPage />);
    expect(screen.getAllByRole("heading", { level: 1 })).toHaveLength(1);
    expect(screen.getByText("Provider capacity still visible")).toBeTruthy();
    expect(screen.getByText("Database backups still visible")).toBeTruthy();
    expect(screen.getByTitle("health-ref")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    expect(mocks.healthRetry).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByRole("button", { name: "Refresh now" }));
    expect(mocks.infrastructureRetry).toHaveBeenCalledTimes(1);
  });
  it.each([["ok", "OK"], ["warning", "Warning"], ["error", "Error"], ["neutral", "Disabled"]] as const)("conveys %s without colour alone", (tone, label) => {
    render(<StatusTile tone={tone} label="Dependency" primary="Status" />);
    expect(screen.getByText(`Status: ${label}`)).toBeTruthy();
  });
  it("shows OFF from the existing health answer and retains only the existing refresh sources", () => {
    mocks.error = null; mocks.data = health({ enabled: false, counters: null });
    render(<AdminHealthPage />);
    expect(screen.getByRole("region", { name: "Personal chart cache" }).textContent).toContain("Off");
    expect(screen.queryByText("Cache hits")).toBeNull();
    expect([...new Set(mocks.requests.map(row => `${row.path}:${row.interval}`))].sort()).toEqual([
      "/v1/admin/health:30000", "/v1/admin/infrastructure:300000",
    ]);
    fireEvent.click(screen.getByRole("button", { name: "Refresh now" }));
    expect(mocks.healthRetry).toHaveBeenCalledTimes(1); expect(mocks.infrastructureRetry).toHaveBeenCalledTimes(1);
  });
  it("shows an older API answer as Not reported rather than Disabled", () => {
    mocks.error = null; mocks.data = health();
    render(<AdminHealthPage />);
    const cache = screen.getByRole("region", { name: "Personal chart cache" });
    expect(cache.textContent).toContain("Not reported"); expect(cache.textContent).not.toContain("Disabled");
  });
  it.each([500, 403])("withholds cached cache-status claims when health fails with %s", status => {
    mocks.data = health({ enabled: true, counters: { hit: 3, miss: 4, entries: 2, bytes: 1000, reserved_bytes: 512 } });
    mocks.error = { status, message: "Probe unavailable", requestId: "health-ref" };
    render(<AdminHealthPage />);
    expect(screen.queryByRole("region", { name: "Personal chart cache" })).toBeNull();
    expect(screen.queryByText("Cache hits")).toBeNull();
    if (status === 500) expect(screen.getByText("Provider capacity still visible")).toBeTruthy();
  });
});
