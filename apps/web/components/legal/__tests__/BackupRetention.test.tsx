import { afterEach, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { BackupRetention } from "../BackupRetention";
const state = { data: null as unknown };
vi.mock("swr", () => ({ default: () => state }));
vi.mock("@/lib/clientApi", () => ({ API_BASE: "https://fixture.local" }));
afterEach(() => { cleanup(); state.data = null; });
it("keeps missing policy honest without inventing a duration", () => {
  render(<BackupRetention />); expect(screen.getByText(/Current database backup retention window is unavailable/)).toBeTruthy();
  expect(screen.queryByText(/7 days/)).toBeNull();
});
it("uses the current safe schedule once available", () => {
  state.data = { available: true, retention: [{ unit: "days", value: 7 }, { unit: "months", value: 1 }, { unit: "days", value: 7 }] };
  render(<BackupRetention />); expect(screen.getByText(/7 days; 1 month/)).toBeTruthy();
  expect(screen.queryByText(/previous database cluster/)).toBeNull();
});
it("keeps stating a previous cluster's longer schedule while its backups exist", () => {
  state.data = {
    available: true,
    retention: [{ unit: "days", value: 8 }],
    legacyRetention: [{ unit: "days", value: 7 }, { unit: "weeks", value: 4 }, { unit: "months", value: 12 }, { unit: "years", value: 1 }],
  };
  render(<BackupRetention />);
  expect(screen.getByText(/Current database backup retention: 8 days\./)).toBeTruthy();
  expect(screen.getByText("Backups from the previous database cluster are also kept and expire under their own schedule: 7 days; 4 weeks; 12 months; 1 year.")).toBeTruthy();
});
it("states the previous cluster's schedule even when the current one is unavailable", () => {
  state.data = { available: false, retention: [], legacyRetention: [{ unit: "years", value: 1 }] };
  render(<BackupRetention />);
  expect(screen.getByText(/retention window is unavailable/)).toBeTruthy();
  expect(screen.getByText(/previous database cluster .* own schedule: 1 year\./)).toBeTruthy();
});
