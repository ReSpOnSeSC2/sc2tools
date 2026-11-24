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
});
