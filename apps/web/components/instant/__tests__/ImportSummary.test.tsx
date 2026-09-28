/**
 * ImportSummary — count rows, the daily-cap notice with the local reset
 * time, the per-run cap note, focus on mount, the headline that is not a
 * live region (panels announce it through their own region), and the
 * original-file backup line (including the neutral "unavailable" copy).
 */
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import type { UploadCounts } from "@/lib/instant/importRunner";
import type { BackupSummary } from "@/lib/instant/replayBackup";
import { BACKUP_UNAVAILABLE_TEXT, ImportSummary, backupLine, importHeadline, stopCopy } from "../ImportSummary";

const COUNTS: UploadCounts = { uploaded: 3, created: 2, skippedExisting: 1, rejected: 0, pending: 0 };
const RESET_AT = Date.parse("2026-09-29T00:00:00Z");

afterEach(cleanup);

function localResume(at: number): string {
  return new Intl.DateTimeFormat(undefined, { weekday: "short", hour: "numeric", minute: "2-digit" }).format(at);
}

describe("stopCopy / importHeadline", () => {
  it("says when uploads resume after the daily cap, when the server said so", () => {
    expect(stopCopy("daily_cap").hint).not.toMatch(/Uploads resume after/);
    expect(stopCopy("daily_cap", RESET_AT).hint).toMatch(new RegExp(`^Uploads resume after ${localResume(RESET_AT)}\\.`));
    expect(stopCopy("auth", RESET_AT).hint).not.toMatch(/Uploads resume/);
  });

  it("names the outcome", () => {
    expect(importHeadline(COUNTS)).toBe("Import complete");
    expect(importHeadline({ ...COUNTS, stoppedReason: "daily_cap" })).toBe("Import stopped early");
    expect(importHeadline({ ...COUNTS, uploaded: 0, created: 0, skippedExisting: 0 })).toBe("No games were uploaded");
  });
});

describe("ImportSummary", () => {
  it("shows the cap notice with the reset time and the per-run cap note", () => {
    render(
      <ImportSummary
        counts={{ ...COUNTS, pending: 4, stoppedReason: "daily_cap", dailyCapResetAt: RESET_AT }}
        failed={[]}
        truncatedCount={12}
        showDashboardLink={false}
      />,
    );
    expect(screen.getByText(new RegExp(`Uploads resume after ${localResume(RESET_AT)}`))).toBeTruthy();
    expect(screen.getByText(/12 older replays were left out of this run/)).toBeTruthy();
    expect(screen.getByText("Not uploaded yet")).toBeTruthy();
  });

  it("focuses the headline only with autoFocus, and keeps it out of live regions", () => {
    const { unmount } = render(<ImportSummary counts={COUNTS} failed={[]} />);
    const heading = screen.getByRole("heading", { name: "Import complete" });
    expect(document.activeElement).not.toBe(heading);
    expect(heading.closest("[role=status]")).toBeNull();
    unmount();
    render(<ImportSummary counts={COUNTS} failed={[]} autoFocus />);
    expect(document.activeElement).toBe(screen.getByRole("heading", { name: "Import complete" }));
  });
});

describe("ImportSummary backup line", () => {
  const EMPTY: BackupSummary = { backedUp: [], alreadyStored: [], skipped: [], failed: [] };

  it("says calmly that the games were imported when backup was unavailable", () => {
    const backup: BackupSummary = { ...EMPTY, alreadyStored: ["g0"], stoppedReason: "unavailable" };
    render(<ImportSummary counts={COUNTS} failed={[]} backup={backup} />);
    const line = screen.getByText(
      "Your games were imported. Original-file backup isn't available right now, so no replay files were uploaded.",
    );
    expect(line.closest("[role=alert]")).toBeNull();
    expect(screen.getByRole("heading", { name: "Import complete" })).toBeTruthy();
  });

  it("keeps the counts when some files went up before backup became unavailable", () => {
    expect(backupLine({ ...EMPTY, backedUp: ["g1", "g2"], stoppedReason: "unavailable" })).toBe(
      "Original replay files: 2 backed up, replay backup is unavailable right now.",
    );
    expect(backupLine({ ...EMPTY, stoppedReason: "unavailable" })).toBe(BACKUP_UNAVAILABLE_TEXT);
    expect(backupLine(EMPTY)).toBeNull();
  });
});
