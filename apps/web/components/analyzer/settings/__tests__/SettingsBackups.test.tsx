import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { SettingsBackups } from "../SettingsBackups";
import { ToastProvider } from "@/components/ui/Toast";
import { loadLazyHelpLink } from "@/components/help/__tests__/loadLazyHelpLink";

const useApiMock = vi.fn();
const apiCallMock = vi.fn();
const mutateMock = vi.fn(async () => undefined);
const forgetDeviceCopy = vi.hoisted(() => vi.fn());

vi.mock("@/lib/analysisCorpus/deviceClear", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/analysisCorpus/deviceClear")>()),
  forgetDeviceCopy,
}));

vi.mock("@clerk/nextjs", () => ({
  useAuth: () => ({ getToken: async () => "test-token", isLoaded: true, isSignedIn: true }),
}));

vi.mock("@/lib/clientApi", () => ({
  useApi: (...args: unknown[]) => useApiMock(...args),
  apiCall: (...args: unknown[]) => apiCallMock(...args),
  API_BASE: "https://api.example.test",
}));

beforeAll(loadLazyHelpLink, 20_000);

afterEach(() => {
  cleanup();
  useApiMock.mockReset();
  apiCallMock.mockReset();
  mutateMock.mockClear();
  forgetDeviceCopy.mockClear();
});

const SNAPSHOT = {
  id: "bk_1754900000000_abcd",
  createdAt: "2026-08-11T09:30:00.000Z",
  sizeBytes: 2_097_152,
  type: "manual",
  label: "Before season",
  counts: { games: 11842, customBuilds: 4, opponentNotes: 3, overlayTokens: 2 },
} as const;

function renderBackups(items: unknown[] = [SNAPSHOT]) {
  useApiMock.mockImplementation((path: string) => {
    if (path === "/v1/me/backups") {
      return { data: { items }, isLoading: false, error: null, mutate: mutateMock };
    }
    // Replay archive card: leave it in its "unavailable" state.
    return { data: null, isLoading: false, error: null };
  });
  return render(
    <ToastProvider>
      <SettingsBackups />
    </ToastProvider>,
  );
}

describe("SettingsBackups copy", () => {
  it("describes streamed retention and export without unverified daily-backup promises", () => {
    renderBackups([]);

    for (const id of ["replay-archive", "snapshots", "repair-data", "device-history", "delete-history", "gdpr"]) {
      expect(document.querySelectorAll(`[id="${id}"]`)).toHaveLength(1);
      expect(document.getElementById(id)?.tagName).toBe("SECTION");
    }
    expect(apiCallMock).not.toHaveBeenCalled();

    expect(screen.getByText(/Your own restore points for your account/)).toBeTruthy();
    expect(screen.getByText(/5 manual snapshots, 2 weekly automatic snapshots and 3 snapshots/)).toBeTruthy();
    expect(screen.queryByText(/MongoDB Atlas/)).toBeNull();
    expect(screen.getByText(/Build orders, charts and replay files for games in both lists are kept/)).toBeTruthy();
    expect(screen.queryByText(/continuous backups/i)).toBeNull();
    expect(screen.getByRole("link", { name: "How backups work" }).getAttribute("href"))
      .toBe("/help/backups-and-export");
    expect(screen.getByText(/Build orders and charts aren't in the file/)).toBeTruthy();
    expect(screen.queryByText(/ML model artifact/)).toBeNull();
  });
});

describe("SettingsBackups restore", () => {
  it("says what a restore replaces, then confirms it finished", async () => {
    apiCallMock.mockImplementation(async (_token, path: string) => path.endsWith("/preview") ? { games: { kept: 11842, removed: 2, added: 1 }, customBuilds: 4, opponentNotes: 3, overlayTokens: 2, currentRevision: "a".repeat(24) } : { restoredAt: "2026-08-11T10:00:00.000Z", counts: { games: 3402 } });
    renderBackups();

    fireEvent.click(screen.getByRole("button", { name: "Restore" }));
    const dialog = screen.getByRole("dialog");
    await within(dialog).findByText("Build orders and replay files for 11,842 games are kept.");
    expect(within(dialog).getByText(/Games added since then are removed/)).toBeTruthy();
    expect(within(dialog).getByText(/Re-sync from the desktop app/)).toBeTruthy();

    fireEvent.click(within(dialog).getByRole("button", { name: "Restore" }));
    await waitFor(() => expect(screen.getByText("Restored 3,402 games")).toBeTruthy());
    // The restored history replaces any copy kept on this device.
    expect(forgetDeviceCopy).toHaveBeenCalledTimes(1);
    expect(apiCallMock).toHaveBeenCalledWith(
      expect.any(Function),
      `/v1/me/backups/${SNAPSHOT.id}/restore`,
      { method: "POST", body: JSON.stringify({ currentRevision: "a".repeat(24) }) },
    );
    expect(screen.queryByText("Restore queued")).toBeNull();
  });

  it("clears the copy kept on this device when a restore may have finished, never after a rejection", async () => {
    const restoreFails = (failure: unknown) => apiCallMock.mockImplementation(async (_token, path: string) => {
      if (path.endsWith("/preview")) return { games: { kept: 11842, removed: 2, added: 1 }, customBuilds: 4, opponentNotes: 3, overlayTokens: 2, currentRevision: "a".repeat(24) };
      throw failure;
    });
    const attempt = async () => {
      renderBackups();
      fireEvent.click(screen.getByRole("button", { name: "Restore" }));
      const dialog = screen.getByRole("dialog");
      await within(dialog).findByText("Build orders and replay files for 11,842 games are kept.");
      fireEvent.click(within(dialog).getByRole("button", { name: "Restore" }));
      await screen.findByText("Couldn't complete snapshot action");
      const cleared = forgetDeviceCopy.mock.calls.length;
      cleanup();
      forgetDeviceCopy.mockClear();
      return cleared;
    };
    restoreFails({ status: 502, message: "Bad gateway" });
    expect(await attempt()).toBe(1);
    restoreFails(new TypeError("Failed to fetch"));
    expect(await attempt()).toBe(1);
    restoreFails({ code: "backup_preview_changed", status: 409, message: "backup_preview_changed" });
    expect(await attempt()).toBe(0);
    // Offline by the time the failure arrives: the restore may have gone through before the connection dropped.
    const offline = vi.spyOn(window.navigator, "onLine", "get").mockReturnValue(false);
    restoreFails(new TypeError("Failed to fetch"));
    expect(await attempt()).toBe(1);
    offline.mockRestore();
  });
});

describe("SettingsBackups game history", () => {
  it("rejects a reversed calendar range before any request", () => {
    renderBackups([]);
    fireEvent.change(screen.getByLabelText("Wipe games on or after this date"), { target: { value: "2025-10-15" } });
    fireEvent.change(screen.getByLabelText("Wipe games through this date (inclusive)"), { target: { value: "2025-10-01" } });
    expect(screen.getByRole("alert").textContent).toContain("From must be on or before Through.");
    expect(screen.getByRole("button", { name: "Delete games in range" }).hasAttribute("disabled")).toBe(true); expect(apiCallMock).not.toHaveBeenCalled();
  });
  it("previews the count without deletion, and blocks confirmation for an empty range", async () => {
    apiCallMock.mockResolvedValue({ dryRun: true, counts: { games: 0 } }); renderBackups([]);
    fireEvent.click(screen.getByRole("button", { name: "Delete all games" }));
    await screen.findByText("No games in this range");
    expect(JSON.parse(apiCallMock.mock.calls[0][2].body)).toEqual({ dryRun: true });
    fireEvent.change(screen.getByLabelText("Type DELETE to confirm"), { target: { value: "DELETE" } });
    expect(screen.getByRole("button", { name: "Delete games" }).hasAttribute("disabled")).toBe(true);
  });
  it("clears game history kept on this device after a wipe that finished or may have, never after a rejection", async () => {
    const wipe = (failure?: unknown) => apiCallMock.mockImplementation(async (_token, _path: string, init: { body: string }) => {
      if (JSON.parse(init.body).dryRun) return { dryRun: true, counts: { games: 5 } };
      if (failure) throw failure;
      return { deleted: true, counts: { games: 5, opponents: 0, macroJobs: 0 } };
    });
    const confirm = async (outcome: string) => {
      renderBackups([]);
      fireEvent.click(screen.getByRole("button", { name: "Delete all games" }));
      await screen.findByText(/This deletes all 5 games/);
      fireEvent.change(screen.getByLabelText("Type DELETE to confirm"), { target: { value: "DELETE" } });
      fireEvent.click(screen.getByRole("button", { name: "Delete games" }));
      await screen.findByText(outcome);
      const cleared = forgetDeviceCopy.mock.calls.length;
      cleanup();
      forgetDeviceCopy.mockClear();
      return cleared;
    };
    wipe({ status: 409, message: "A wipe is already running" });
    expect(await confirm("Couldn't wipe game history")).toBe(0);
    // No answer at all, or a server error: the wipe may have finished.
    wipe(new TypeError("Failed to fetch"));
    expect(await confirm("Couldn't wipe game history")).toBe(1);
    wipe({ status: 502, message: "Bad gateway" });
    expect(await confirm("Couldn't wipe game history")).toBe(1);
    wipe({ status: 500, message: "Internal error" });
    expect(await confirm("Couldn't wipe game history")).toBe(1);
    wipe({ status: 400, message: "Bad range" });
    expect(await confirm("Couldn't wipe game history")).toBe(0);
    wipe();
    expect(await confirm("Deleted 5 games")).toBe(1);
  });
});


describe("snapshot safeguards", () => {
  it("blocks restore until a successful preview, keeps data untouched on failure, and retries", async () => {
    apiCallMock.mockRejectedValueOnce(new Error("offline")); renderBackups();
    fireEvent.click(screen.getByRole("button", { name: "Restore" }));
    const dialog = screen.getByRole("dialog");
    expect(within(dialog).getByRole("button", { name: "Restore" }).hasAttribute("disabled")).toBe(true);
    await within(dialog).findByText(/Couldn't preview this snapshot/);
    expect(apiCallMock.mock.calls.every((call) => String(call[1]).endsWith("/preview"))).toBe(true);
    apiCallMock.mockResolvedValueOnce({ games: { kept: 11842, removed: 2, added: 1 }, customBuilds: 4, opponentNotes: 3, overlayTokens: 2, currentRevision: "a".repeat(24) });
    fireEvent.click(within(dialog).getByRole("button", { name: "Try again" }));
    await within(dialog).findByText("Build orders and replay files for 11,842 games are kept.");
    expect(within(dialog).getByRole("button", { name: "Restore" }).hasAttribute("disabled")).toBe(false);
  });
  it("shows count chips and saves a label explicitly without losing a failed draft", async () => {
    apiCallMock.mockRejectedValueOnce(new Error("offline")); renderBackups();
    expect(screen.getByText("11,842 games")).toBeTruthy();
    const label = screen.getByLabelText(`Snapshot label ${SNAPSHOT.id}`);
    fireEvent.change(label, { target: { value: "Keep this point" } });
    fireEvent.click(screen.getByRole("button", { name: "Save label" }));
    await screen.findByText("Couldn't complete snapshot action");
    expect((label as HTMLInputElement).value).toBe("Keep this point");
    expect(apiCallMock).toHaveBeenCalledWith(expect.any(Function), `/v1/me/backups/${SNAPSHOT.id}`, { method: "PATCH", body: JSON.stringify({ label: "Keep this point" }) });
  });
  it("refreshes the preview after a newly synced game changes its revision", async () => {
    apiCallMock.mockResolvedValueOnce({ games: { kept: 1, removed: 0, added: 0 }, customBuilds: 0, opponentNotes: 0, overlayTokens: 0, currentRevision: "a".repeat(24) })
      .mockRejectedValueOnce({ code: "backup_preview_changed", status: 409, message: "backup_preview_changed" })
      .mockResolvedValueOnce({ games: { kept: 1, removed: 1, added: 0 }, customBuilds: 0, opponentNotes: 0, overlayTokens: 0, currentRevision: "b".repeat(24) });
    renderBackups(); fireEvent.click(screen.getByRole("button", { name: "Restore" }));
    const dialog = screen.getByRole("dialog"); await within(dialog).findByText("0 current games removed");
    fireEvent.click(within(dialog).getByRole("button", { name: "Restore" }));
    await within(dialog).findByText("1 current games removed");
    expect(apiCallMock.mock.calls.filter((call) => String(call[1]).endsWith("/restore"))).toHaveLength(1);
    expect(screen.getByText("Your game history changed after this preview. Review the updated changes before restoring.")).toBeTruthy();
  });
  it("deletes only after the snapshot-specific confirmation", async () => {
    apiCallMock.mockResolvedValue({ deleted: true }); renderBackups();
    fireEvent.click(screen.getByRole("button", { name: "Delete snapshot" }));
    expect(apiCallMock).not.toHaveBeenCalled();
    const dialog = screen.getByRole("dialog");
    fireEvent.click(within(dialog).getByRole("button", { name: "Delete snapshot" }));
    await screen.findByText("Snapshot deleted");
    expect(apiCallMock).toHaveBeenCalledWith(expect.any(Function), `/v1/me/backups/${SNAPSHOT.id}`, { method: "DELETE" });
  });
  it("shows the hourly repair limit with a real retry path", async () => {
    apiCallMock.mockRejectedValueOnce({ code: "repair_rate_limited", status: 429, message: "repair_rate_limited" }); renderBackups([]);
    fireEvent.click(screen.getByRole("button", { name: "Recount opponent records" }));
    await screen.findByText("This repair can run once an hour. Try again after the cooldown.");
    apiCallMock.mockResolvedValueOnce({ accepted: true });
    fireEvent.click(screen.getByRole("button", { name: "Recount opponent records" }));
    await screen.findByText("Repair started");
    expect(apiCallMock).toHaveBeenLastCalledWith(expect.any(Function), "/v1/me/repair/opponents", { method: "POST", body: "{}" });
    // A repair neither deletes nor restores history, so the copy kept on this device stays.
    expect(forgetDeviceCopy).not.toHaveBeenCalled();
  });
});
