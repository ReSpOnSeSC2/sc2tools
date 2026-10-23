import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import AdminHealthPage from "./page";
import { StatusTile } from "../components/StatusTile";
const mocks = vi.hoisted(() => ({ healthRetry: vi.fn(), infrastructureRetry: vi.fn() }));
vi.mock("@/lib/clientApi", () => ({ useApi: (path: string) => path.endsWith("/health")
  ? { error: { status: 500, message: "Probe unavailable", requestId: "health-ref" }, mutate: mocks.healthRetry }
  : { error: null, data: { asOf: "2026-10-01" }, mutate: mocks.infrastructureRetry } }));
vi.mock("../components/InfrastructureOverview", () => ({ InfrastructureOverview: () => <div>Provider capacity still visible</div> }));
vi.mock("../components/BackgroundJobs", () => ({ BackgroundJobs: () => <div>Background jobs still visible</div> }));
vi.mock("../components/DatabaseBackupsCard", () => ({ DatabaseBackupsCard: () => <div>Database backups still visible</div> }));
afterEach(cleanup);
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
});
