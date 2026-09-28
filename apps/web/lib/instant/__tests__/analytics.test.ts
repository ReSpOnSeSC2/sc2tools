import { afterEach, describe, expect, it, vi } from "vitest";

const { gaEvent } = vi.hoisted(() => ({ gaEvent: vi.fn() }));
// Mock: capture GA4 events instead of touching window.gtag.
vi.mock("@/lib/analytics/gtag", () => ({ gaEvent }));

import {
  medianMs,
  trackInstantError,
  trackInstantFilesSelected,
  trackInstantFolderSyncResume,
  trackInstantOpen,
  trackInstantParseDone,
  trackInstantReportView,
  trackInstantSignupClick,
  trackInstantUploadDone,
} from "../analytics";

afterEach(() => gaEvent.mockReset());

describe("instant analytics", () => {
  it("emits the eight contract events with numeric/enum params only", () => {
    trackInstantOpen();
    trackInstantFilesSelected({ count: 12.4, source: "drop" });
    trackInstantParseDone({ ok: 9, failed: 1, medianMs: 1402.6 });
    trackInstantReportView();
    trackInstantSignupClick();
    trackInstantUploadDone({ games: 9 });
    trackInstantFolderSyncResume();
    trackInstantError({ kind: "engine_boot_failed" });
    expect(gaEvent.mock.calls).toEqual([
      ["instant_open"],
      ["instant_files_selected", { count: 12, source: "drop" }],
      ["instant_parse_done", { ok: 9, failed: 1, median_ms: 1403 }],
      ["instant_report_view"],
      ["instant_signup_click"],
      ["instant_upload_done", { games: 9 }],
      ["instant_folder_sync_resume"],
      ["instant_error", { kind: "engine_boot_failed" }],
    ]);
  });

  it("sanitises counts", () => {
    trackInstantParseDone({ ok: -3, failed: Number.NaN, medianMs: null });
    expect(gaEvent).toHaveBeenCalledWith("instant_parse_done", { ok: 0, failed: 0, median_ms: 0 });
  });

  it("computes medians", () => {
    expect(medianMs([30, 10, 20])).toBe(20);
    expect(medianMs([10, 20, 30, 40])).toBe(25);
    expect(medianMs([])).toBeNull();
  });
});
