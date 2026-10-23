import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";

import {
  backupTone,
  DatabaseBackupsCard,
  normalizeAdminBackups,
  retentionLabel,
  snapshotAge,
  timeUntil,
} from "./DatabaseBackupsCard";
import type { AdminBackupsResp, AtlasBackupStatus } from "./adminTypes";

const useApiMock = vi.fn();

vi.mock("@clerk/nextjs", () => ({
  useAuth: () => ({ isLoaded: true, isSignedIn: true, userId: "admin-fixture" }),
}));

vi.mock("@/lib/clientApi", () => ({
  useApi: (...args: unknown[]) => useApiMock(...args),
}));

afterEach(() => {
  cleanup();
  useApiMock.mockReset();
});

const HOUR = 60 * 60 * 1000;

function hoursAgo(hours: number): string {
  return new Date(Date.now() - hours * HOUR).toISOString();
}

function atlas(overrides: Partial<AtlasBackupStatus> = {}): AtlasBackupStatus {
  return {
    configured: true,
    available: true,
    stale: false,
    checkedAt: new Date().toISOString(),
    errorCode: null,
    freshness: "fresh",
    ageHours: 5,
    lastSnapshotAt: hoursAgo(5),
    latestStatus: "completed",
    completedSnapshotCount: 31,
    nextSnapshotAt: new Date(Date.now() + 3 * HOUR).toISOString(),
    retention: [
      { frequency: "hourly", everyHours: 6, keep: 2, unit: "days" },
      { frequency: "daily", everyHours: null, keep: 7, unit: "days" },
      { frequency: "monthly", everyHours: null, keep: 12, unit: "months" },
    ],
    cloudBackupEnabled: true,
    pointInTime: { enabled: true, windowDays: 2 },
    ...overrides,
  };
}

function payload(atlasStatus: AtlasBackupStatus = atlas()): AdminBackupsResp {
  return {
    asOf: new Date().toISOString(),
    thresholds: { freshMaxHours: 26, agingMaxHours: 50 },
    atlas: atlasStatus,
    inApp: {
      snapshotCount: 42,
      userCount: 17,
      newestAt: hoursAgo(72),
      storageBytes: 7_340_032,
    },
  };
}

function renderCard(data: unknown, extra: Record<string, unknown> = {}) {
  useApiMock.mockReturnValue({
    data,
    error: null,
    isLoading: false,
    isValidating: false,
    mutate: vi.fn(),
    ...extra,
  });
  return render(<DatabaseBackupsCard />);
}

function ageDot(): string {
  return screen.getByTestId("backup-age-dot").className;
}

describe("DatabaseBackupsCard colour thresholds", () => {
  it("is green while the newest snapshot is under 26 hours old", () => {
    renderCard(payload(atlas({ freshness: "fresh", ageHours: 25.9, lastSnapshotAt: hoursAgo(25.9) })));
    expect(ageDot()).toContain("bg-success");
    expect(screen.getByText("On time")).toBeTruthy();
    expect(screen.getByText("25 h ago")).toBeTruthy();
  });

  it("is amber from 26 hours and explains it is late", () => {
    renderCard(payload(atlas({ freshness: "aging", ageHours: 26, lastSnapshotAt: hoursAgo(26) })));
    expect(ageDot()).toContain("bg-warning");
    expect(screen.getByText("Late")).toBeTruthy();
    expect(screen.getByText(/newest snapshot is late/i)).toBeTruthy();
  });

  it("is red from 50 hours and when there is no snapshot", () => {
    renderCard(payload(atlas({ freshness: "stale", ageHours: 50, lastSnapshotAt: hoursAgo(50) })));
    expect(ageDot()).toContain("bg-danger");
    expect(screen.getByText("Overdue")).toBeTruthy();
    cleanup();

    renderCard(payload(atlas({ freshness: "missing", ageHours: null, lastSnapshotAt: null })));
    expect(ageDot()).toContain("bg-danger");
    expect(screen.getByText("None yet")).toBeTruthy();
    expect(screen.getByText(/no completed snapshot/i)).toBeTruthy();
  });

  it("maps every freshness band to one tone", () => {
    expect(backupTone("fresh")).toBe("ok");
    expect(backupTone("aging")).toBe("warning");
    expect(backupTone("stale")).toBe("error");
    expect(backupTone("missing")).toBe("error");
    expect(backupTone("unknown")).toBe("neutral");
  });
});

describe("DatabaseBackupsCard details", () => {
  it("shows the schedule, retention, point-in-time window and in-app counts", () => {
    renderCard(payload());
    expect(useApiMock).toHaveBeenCalledWith("/v1/admin/backups", { refreshInterval: 5 * 60_000 });
    const section = screen.getByRole("heading", { name: "Database backups" }).closest("section")!;
    expect(within(section).getByText("Every 6 hours, kept 2 days")).toBeTruthy();
    expect(within(section).getByText("Daily, kept 7 days")).toBeTruthy();
    expect(within(section).getByText("Monthly, kept 12 months")).toBeTruthy();
    expect(within(section).getByText("On, any moment in the last 2 days")).toBeTruthy();
    expect(within(section).getByText("Completed")).toBeTruthy();
    expect(within(section).getByText(/^in 3h · /)).toBeTruthy();
    expect(within(section).getByText("42")).toBeTruthy();
    expect(within(section).getByText("from 17 users")).toBeTruthy();
    expect(within(section).getByText("3d ago")).toBeTruthy();
    expect(within(section).getByText("7.34 MB")).toBeTruthy();
    expect(within(section).getByText("docs/runbooks/restore-database.md")).toBeTruthy();
    expect(within(section).getByRole("link", { name: "What users are told about backups" }).getAttribute("href"))
      .toBe("/help/backups-and-export");
  });

  it("flags a failed newest run in red", () => {
    renderCard(payload(atlas({ latestStatus: "failed" })));
    expect(screen.getByText("Failed").className).toContain("text-danger");
  });

  it("explains a missing setup without inventing a snapshot age", () => {
    renderCard(payload(atlas({
      configured: false,
      available: false,
      errorCode: "not_configured",
      freshness: "unknown",
      ageHours: null,
      lastSnapshotAt: null,
      retention: [],
    })));
    expect(screen.getByText("Not connected")).toBeTruthy();
    expect(screen.getByText("Unknown")).toBeTruthy();
    expect(screen.getByText(/ATLAS_\* service-account settings in Render/)).toBeTruthy();
    expect(screen.queryByText("Schedule and retention")).toBeNull();
    expect(ageDot()).toContain("bg-text-dim");
  });

  it("tells the admin which Atlas role is missing on a 403", () => {
    renderCard(payload(atlas({
      available: false,
      errorCode: "atlas_backup_forbidden",
      freshness: "unknown",
      lastSnapshotAt: null,
    })));
    expect(screen.getByText(/Project Read Only role/)).toBeTruthy();
  });

  it("labels a last-good result after a failed check", () => {
    renderCard(payload(atlas({ stale: true, errorCode: "atlas_backup_unavailable" })));
    expect(screen.getByText(/This is the last good result/)).toBeTruthy();
  });

  it("warns when Cloud Backup is off for the cluster", () => {
    renderCard(payload(atlas({ cloudBackupEnabled: false, freshness: "missing", lastSnapshotAt: null })));
    expect(screen.getByText(/Cloud Backup is off for this cluster/)).toBeTruthy();
  });

  it("announces loading to screen readers", () => {
    renderCard(undefined, { isLoading: true });
    expect(screen.getByRole("status").textContent).toBe("Loading backup status…");
    expect(screen.queryByText("Backup status couldn't load")).toBeNull();
  });

  it("offers Retry when the request fails instead of showing an empty card", () => {
    const mutate = vi.fn();
    renderCard(undefined, { error: { status: 500, message: "boom" }, mutate });
    expect(screen.getByText("Backup status couldn't load")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    expect(mutate).toHaveBeenCalledTimes(1);
  });

  it("treats an answer that isn't the backups contract as a failure, with Retry", () => {
    const mutate = vi.fn();
    renderCard({ mongo: { ok: true } }, { mutate });
    expect(screen.getByText("Backup status couldn't load")).toBeTruthy();
    expect(screen.getByRole("alert")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    expect(mutate).toHaveBeenCalledTimes(1);
  });
});

describe("backup card helpers", () => {
  it("rejects payloads that aren't the backups contract", () => {
    expect(normalizeAdminBackups(null)).toBeNull();
    expect(normalizeAdminBackups({ mongo: { ok: true } })).toBeNull();
    expect(normalizeAdminBackups({ atlas: { configured: true, available: true, freshness: "sideways" } })).toBeNull();
    const parsed = normalizeAdminBackups({
      atlas: {
        configured: true,
        available: true,
        freshness: "fresh",
        hostname: "hidden.example",
        retention: [
          { frequency: "daily", everyHours: null, keep: 7, unit: "days" },
          { frequency: "fortnightly", everyHours: null, keep: 2, unit: "weeks" },
          "junk",
        ],
      },
      inApp: { snapshotCount: "lots" },
    });
    expect(parsed?.atlas.retention).toEqual([
      { frequency: "daily", everyHours: null, keep: 7, unit: "days" },
    ]);
    expect(parsed?.inApp).toBeNull();
    expect(parsed?.thresholds).toEqual({ freshMaxHours: 26, agingMaxHours: 50 });
    expect(JSON.stringify(parsed)).not.toContain("hidden.example");
  });

  it("writes retention in plain words", () => {
    expect(retentionLabel({ frequency: "hourly", everyHours: 1, keep: 1, unit: "days" })).toBe("Every hour, kept 1 day");
    expect(retentionLabel({ frequency: "weekly", everyHours: null, keep: 4, unit: "weeks" })).toBe("Weekly, kept 4 weeks");
    expect(retentionLabel({ frequency: "yearly", everyHours: null, keep: 1, unit: "years" })).toBe("Yearly, kept 1 year");
  });

  it("keeps snapshot age in hours around the 26 h and 50 h lines", () => {
    const now = Date.parse("2026-08-11T12:00:00.000Z");
    expect(snapshotAge("2026-08-11T11:35:00.000Z", now)).toBe("25 min ago");
    expect(snapshotAge("2026-08-09T10:00:00.000Z", now)).toBe("50 h ago");
    expect(snapshotAge("2026-08-07T12:00:00.000Z", now)).toBe("4 days ago");
    expect(snapshotAge("2026-08-11T13:00:00.000Z", now)).toBe("0 min ago");
  });

  it("counts down to the next snapshot", () => {
    const now = Date.parse("2026-08-11T12:00:00.000Z");
    expect(timeUntil("2026-08-11T12:30:00.000Z", now)).toBe("in 30m");
    expect(timeUntil("2026-08-11T18:00:00.000Z", now)).toBe("in 6h");
    expect(timeUntil("2026-08-14T12:00:00.000Z", now)).toBe("in 3d");
    expect(timeUntil("2026-08-11T11:00:00.000Z", now)).toBe("due now");
  });
});
