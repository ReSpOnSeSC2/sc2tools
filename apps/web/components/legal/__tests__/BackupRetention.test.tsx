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
  // The current schedule speaks only for the current database's backups...
  expect(screen.getByText("Current database backup retention: 8 days. Copies inside the current database's backups are not edited individually and expire under this schedule.")).toBeTruthy();
  // ...and the retained cluster itself, not just its backups, is disclosed with the longest retention.
  expect(screen.getByText("A previous database cluster is still kept for rollback. It holds a copy of accounts as they were when we moved to the current database, including accounts deleted since. That copy remains until the cluster is deleted, and its backups expire under their own schedule, up to 1 year (7 days; 4 weeks; 12 months; 1 year).")).toBeTruthy();
});
it("states the previous cluster's copy even when the current schedule is unavailable", () => {
  state.data = { available: false, retention: [], legacyRetention: [{ unit: "weeks", value: 4 }, { unit: "months", value: 12 }] };
  render(<BackupRetention />);
  expect(screen.getByText(/retention window is unavailable/)).toBeTruthy();
  expect(screen.getByText(/previous database cluster is still kept .* up to 12 months \(4 weeks; 12 months\)\./)).toBeTruthy();
});
