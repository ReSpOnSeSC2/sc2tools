/**
 * FolderSyncAutoRunner — debounced focus/visibility checks, the 10-minute
 * rule, the "Resume sync" banner for a folder that needs a fresh grant,
 * and background runs. Storage, permissions and the sync pass are MOCK
 * deps injected through the `deps` prop; Clerk and GA4 are mocked.
 */
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { DirectoryHandleLike, ReadPermission } from "@/lib/instant/folderSync";
import type { FolderSyncSummary } from "@/lib/instant/folderSyncRunner";
import { AUTO_SYNC_DEBOUNCE_MS, FolderSyncAutoRunner, nextUtcMidnight, type AutoRunnerDeps } from "../FolderSyncAutoRunner";

const { gaEvent } = vi.hoisted(() => ({ gaEvent: vi.fn() }));
vi.mock("@/lib/analytics/gtag", () => ({ gaEvent }));
vi.mock("@clerk/nextjs", () => ({ useAuth: () => ({ getToken: async () => "token" }) }));
vi.mock("@/lib/clientApi", () => ({ API_BASE: "https://api.test", apiCall: vi.fn() }));

const NOW = Date.parse("2026-09-28T12:00:00Z");
const MINUTE = 60 * 1000;
const HANDLE: DirectoryHandleLike = {
  kind: "directory",
  name: "StarCraft II",
  values: () => ({ async *[Symbol.asyncIterator]() {} }),
};

function summary(uploaded: number): FolderSyncSummary {
  return {
    found: 3, newFiles: uploaded, processed: uploaded, failed: [], aborted: false, engineStarted: uploaded > 0,
    uploaded, created: uploaded, skippedExisting: 0, rejected: 0, pending: 0,
  };
}

/** MOCK deps: a remembered folder, never scanned, read access granted. */
function mockDeps(overrides: Partial<AutoRunnerDeps> = {}) {
  return {
    loadFolderHandle: vi.fn(async (): Promise<DirectoryHandleLike | null> => HANDLE),
    getLastFolderScanAt: vi.fn(async (): Promise<number | null> => null),
    queryReadPermission: vi.fn(async (): Promise<ReadPermission> => "granted"),
    requestReadPermission: vi.fn(async (): Promise<ReadPermission> => "granted"),
    runSync: vi.fn(async (): Promise<FolderSyncSummary | null> => summary(2)),
    now: () => NOW,
    ...overrides,
  };
}

/** Let the debounce elapse and every queued promise settle. */
async function elapse(ms: number): Promise<void> {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });
}

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  gaEvent.mockReset();
});

describe("FolderSyncAutoRunner", () => {
  it("debounces focus bursts into one check", async () => {
    const deps = mockDeps();
    render(<FolderSyncAutoRunner deps={deps} />);
    await elapse(AUTO_SYNC_DEBOUNCE_MS / 2);
    fireEvent.focus(window);
    await elapse(AUTO_SYNC_DEBOUNCE_MS / 2);
    fireEvent.focus(window);
    await elapse(AUTO_SYNC_DEBOUNCE_MS - 1);
    expect(deps.loadFolderHandle).not.toHaveBeenCalled();
    await elapse(1);
    expect(deps.loadFolderHandle).toHaveBeenCalledTimes(1);
    expect(deps.runSync).toHaveBeenCalledTimes(1);
  });

  it("checks again when the tab becomes visible", async () => {
    const deps = mockDeps({ getLastFolderScanAt: vi.fn(async () => NOW - MINUTE) });
    render(<FolderSyncAutoRunner deps={deps} />);
    await elapse(AUTO_SYNC_DEBOUNCE_MS);
    expect(deps.getLastFolderScanAt).toHaveBeenCalledTimes(1);
    fireEvent(document, new Event("visibilitychange"));
    await elapse(AUTO_SYNC_DEBOUNCE_MS);
    expect(deps.getLastFolderScanAt).toHaveBeenCalledTimes(2);
  });

  it("waits 10 minutes between scans", async () => {
    const recent = mockDeps({ getLastFolderScanAt: vi.fn(async () => NOW - 9 * MINUTE) });
    render(<FolderSyncAutoRunner deps={recent} />);
    await elapse(AUTO_SYNC_DEBOUNCE_MS);
    expect(recent.queryReadPermission).not.toHaveBeenCalled();
    expect(recent.runSync).not.toHaveBeenCalled();
    cleanup();

    const due = mockDeps({ getLastFolderScanAt: vi.fn(async () => NOW - 10 * MINUTE) });
    render(<FolderSyncAutoRunner deps={due} />);
    await elapse(AUTO_SYNC_DEBOUNCE_MS);
    expect(due.runSync).toHaveBeenCalledTimes(1);
  });

});

describe("FolderSyncAutoRunner: permission", () => {
  it("does nothing without a remembered folder or when access is denied", async () => {
    const none = mockDeps({ loadFolderHandle: vi.fn(async () => null) });
    const denied = mockDeps({ queryReadPermission: vi.fn(async (): Promise<ReadPermission> => "denied") });
    render(
      <>
        <FolderSyncAutoRunner deps={none} />
        <FolderSyncAutoRunner deps={denied} />
      </>,
    );
    await elapse(AUTO_SYNC_DEBOUNCE_MS);
    expect(none.runSync).not.toHaveBeenCalled();
    expect(denied.runSync).not.toHaveBeenCalled();
    expect(screen.queryByRole("button", { name: "Resume sync" })).toBeNull();
  });

  it("offers Resume sync when the grant expired and syncs after the click", async () => {
    const deps = mockDeps({ queryReadPermission: vi.fn(async (): Promise<ReadPermission> => "prompt") });
    render(<FolderSyncAutoRunner deps={deps} />);
    await elapse(AUTO_SYNC_DEBOUNCE_MS);
    expect(deps.runSync).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: "Resume sync" }));
    expect(deps.requestReadPermission).toHaveBeenCalledWith(HANDLE);
    await elapse(0);
    expect(gaEvent).toHaveBeenCalledWith("instant_folder_sync_resume");
    expect(deps.runSync).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole("button", { name: "Resume sync" })).toBeNull();
  });

  it("hides the banner for the rest of the visit after Not now", async () => {
    const deps = mockDeps({ queryReadPermission: vi.fn(async (): Promise<ReadPermission> => "prompt") });
    render(<FolderSyncAutoRunner deps={deps} />);
    await elapse(AUTO_SYNC_DEBOUNCE_MS);
    fireEvent.click(screen.getByRole("button", { name: "Not now" }));
    fireEvent.focus(window);
    await elapse(AUTO_SYNC_DEBOUNCE_MS);
    expect(screen.queryByRole("button", { name: "Resume sync" })).toBeNull();
  });

});

describe("FolderSyncAutoRunner: background runs", () => {
  it("shows a status chip while a granted folder syncs in the background", async () => {
    let finish: (value: FolderSyncSummary) => void = () => undefined;
    const deps = mockDeps({
      runSync: vi.fn(() => new Promise<FolderSyncSummary | null>((resolve) => {
        finish = resolve;
      })),
    });
    render(<FolderSyncAutoRunner deps={deps} />);
    await elapse(AUTO_SYNC_DEBOUNCE_MS);
    expect(screen.getByRole("status").textContent).toContain("Syncing new replays");

    fireEvent.focus(window);
    await elapse(AUTO_SYNC_DEBOUNCE_MS);
    expect(deps.runSync).toHaveBeenCalledTimes(1); // one sync at a time

    await act(async () => finish(summary(0)));
    expect(screen.queryByRole("status")).toBeNull();
  });

  it("announces the sync once while the per-file count stays visual", async () => {
    let report: (progress: { stage: "reading"; done: number; total: number }) => void = () => undefined;
    const deps = mockDeps({
      runSync: vi.fn((_handle: DirectoryHandleLike, _signal: AbortSignal, onProgress) => {
        report = onProgress;
        return new Promise<FolderSyncSummary | null>(() => undefined);
      }),
    });
    render(<FolderSyncAutoRunner deps={deps} />);
    await elapse(AUTO_SYNC_DEBOUNCE_MS);
    await act(async () => report({ stage: "reading", done: 3, total: 10 }));
    expect(screen.getByRole("status").textContent).toBe("Syncing new replays from your folder");
    expect(screen.getByText("· 3 of 10", { exact: false }).getAttribute("aria-hidden")).toBe("true");
  });

});

describe("FolderSyncAutoRunner: daily cap and unmount", () => {
  it("pauses auto-sync until midnight UTC after the daily upload cap", async () => {
    let now = NOW;
    const capped: FolderSyncSummary = { ...summary(1), stoppedReason: "daily_cap", pending: 4 };
    const deps = mockDeps({ now: () => now, runSync: vi.fn(async () => capped) });
    render(<FolderSyncAutoRunner deps={deps} />);
    await elapse(AUTO_SYNC_DEBOUNCE_MS);
    expect(deps.runSync).toHaveBeenCalledTimes(1);

    now = NOW + 11 * MINUTE;
    fireEvent.focus(window);
    await elapse(AUTO_SYNC_DEBOUNCE_MS);
    expect(deps.loadFolderHandle).toHaveBeenCalledTimes(1);
    expect(deps.runSync).toHaveBeenCalledTimes(1);

    now = nextUtcMidnight(NOW);
    fireEvent.focus(window);
    await elapse(AUTO_SYNC_DEBOUNCE_MS);
    expect(deps.runSync).toHaveBeenCalledTimes(2);
  });

  it("cancels a running sync on unmount", async () => {
    let seen: AbortSignal | null = null;
    const deps = mockDeps({
      runSync: vi.fn((_handle: DirectoryHandleLike, signal: AbortSignal) => {
        seen = signal;
        return new Promise<FolderSyncSummary | null>(() => undefined);
      }),
    });
    const view = render(<FolderSyncAutoRunner deps={deps} />);
    await elapse(AUTO_SYNC_DEBOUNCE_MS);
    view.unmount();
    expect(seen).not.toBeNull();
    expect((seen as AbortSignal | null)?.aborted).toBe(true);
  });
});

describe("nextUtcMidnight", () => {
  it("returns the start of the next UTC day", () => {
    expect(nextUtcMidnight(Date.parse("2026-09-28T12:00:00Z"))).toBe(Date.parse("2026-09-29T00:00:00Z"));
    expect(nextUtcMidnight(Date.parse("2026-09-28T00:00:00Z"))).toBe(Date.parse("2026-09-29T00:00:00Z"));
  });
});
