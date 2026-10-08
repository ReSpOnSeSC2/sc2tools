/**
 * FolderSyncCard — Chromium picker flow vs the Firefox/Safari one-off
 * folder import, "Resume sync" inside the click, "Stop syncing", the
 * account binding of a remembered folder and "Forget import history".
 * Storage (IndexedDB) and the sync runner are MOCKS; Clerk, useApi and
 * GA4 are mocked. The directory handle is a MOCK object.
 */
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { DirectoryHandleLike } from "@/lib/instant/folderSync";
import type { FolderSyncInput, FolderSyncSummary } from "@/lib/instant/folderSyncRunner";
import { FolderSyncCard } from "../FolderSyncCard";

const mocks = vi.hoisted(() => ({
  handle: null as DirectoryHandleLike | null,
  owner: "user_me" as string | null,
  ledger: { synced: 4, total: 6 },
  runs: [] as FolderSyncInput[],
  /** Overrides the default one-new-game result of a sync pass. */
  pass: null as ((input: FolderSyncInput) => Promise<FolderSyncSummary>) | null,
  clearFolderHandle: vi.fn(async () => undefined),
  clearLedger: vi.fn(async () => undefined),
  claimFolderSync: vi.fn(async (_userId: string) => undefined),
  gaEvent: vi.fn(),
}));

vi.mock("@/lib/analytics/gtag", () => ({ gaEvent: mocks.gaEvent }));
vi.mock("@clerk/nextjs", () => ({ useAuth: () => ({ getToken: async () => "token", userId: "user_me" }) }));
vi.mock("@/lib/clientApi", () => ({ API_BASE: "https://api.test", apiCall: vi.fn() }));
vi.mock("@/lib/instant/localStore", () => ({
  loadFolderHandle: async () => mocks.handle,
  getFolderOwner: async () => mocks.owner,
  getLastFolderScanAt: async () => null,
  saveFolderHandle: async () => undefined,
  clearFolderHandle: mocks.clearFolderHandle,
  clearLedger: mocks.clearLedger,
  claimFolderSync: mocks.claimFolderSync,
}));
vi.mock("@/lib/instant/folderSyncRunner", () => ({
  fetchProfileToons: async () => [],
  folderLedgerCounts: async () => mocks.ledger,
  runFolderSyncExclusive: async (input: FolderSyncInput): Promise<FolderSyncSummary> => {
    mocks.runs.push(input);
    if (mocks.pass) return mocks.pass(input);
    return {
      found: 5, newFiles: 1, processed: 1, failed: [], aborted: false, engineStarted: true,
      uploaded: 1, created: 1, skippedExisting: 0, rejected: 0, pending: 0,
    };
  },
}));

function mockHandle(permission: PermissionState): DirectoryHandleLike & { requestPermission: ReturnType<typeof vi.fn> } {
  return {
    kind: "directory",
    name: "StarCraft II",
    values: () => ({ async *[Symbol.asyncIterator]() {} }),
    queryPermission: async () => permission,
    requestPermission: vi.fn(async () => "granted" as PermissionState),
  };
}

const EMPTY_RUN: FolderSyncSummary = {
  found: 0, newFiles: 0, processed: 0, failed: [], aborted: false, engineStarted: false,
  uploaded: 0, created: 0, skippedExisting: 0, rejected: 0, pending: 0,
};

beforeEach(() => {
  mocks.handle = null;
  mocks.owner = "user_me";
  mocks.ledger = { synced: 4, total: 6 };
  mocks.runs = [];
  mocks.pass = null;
  mocks.gaEvent.mockReset();
  mocks.clearLedger.mockClear();
  mocks.clearFolderHandle.mockClear();
  mocks.claimFolderSync.mockClear();
});

function confirmIn(dialogLabel: string): Promise<void> {
  const dialog = screen.getByRole("dialog");
  const confirm = Array.from(dialog.querySelectorAll("button")).find((button) => button.textContent === dialogLabel);
  return act(async () => {
    confirm?.click();
  });
}

afterEach(() => {
  cleanup();
  Reflect.deleteProperty(window, "showDirectoryPicker");
});

describe("FolderSyncCard", () => {
  it("offers a one-off folder import where folders can't be remembered", async () => {
    render(<FolderSyncCard />);
    const button = await screen.findByRole("button", { name: "Import a replay folder" });
    expect(button).toBeTruthy();
    expect(screen.getByText(/automatic Folder Sync needs Chrome or Edge/)).toBeTruthy();
    expect(screen.queryByText(/Pick your StarCraft II folder once/)).toBeNull();
    expect(screen.queryByText("Chrome & Edge")).toBeNull();

    const replay = new File(["abc"], "a.SC2Replay", { lastModified: 1 });
    Object.defineProperty(replay, "webkitRelativePath", { value: "SC2/1-S2-1-111/Replays/Multiplayer/a.SC2Replay" });
    fireEvent.change(screen.getByLabelText("Replay folder to import"), { target: { files: [replay] } });
    await waitFor(() => expect(mocks.runs).toHaveLength(1));
    const source = mocks.runs[0]?.source;
    expect(source && "files" in source ? source.files.map((file) => file.relativePath) : []).toEqual([
      "SC2/1-S2-1-111/Replays/Multiplayer/a.SC2Replay",
    ]);
    expect(mocks.runs[0]?.ownerUserId).toBe("user_me");
  });

  it("lets Firefox/Safari users forget their import history", async () => {
    render(<FolderSyncCard />);
    fireEvent.click(await screen.findByRole("button", { name: "Forget import history" }));
    await confirmIn("Forget import history");
    expect(mocks.clearLedger).toHaveBeenCalledTimes(1);
    await waitFor(() => expect(screen.queryByRole("button", { name: "Forget import history" })).toBeNull());
  });

  it("binds a Firefox/Safari import to the signed-in account first", async () => {
    mocks.owner = "user_other";
    render(<FolderSyncCard />);
    const replay = new File(["abc"], "a.SC2Replay", { lastModified: 1 });
    Object.defineProperty(replay, "webkitRelativePath", { value: "SC2/1-S2-1-111/Replays/Multiplayer/a.SC2Replay" });
    fireEvent.change(await screen.findByLabelText("Replay folder to import"), { target: { files: [replay] } });
    await waitFor(() => expect(mocks.runs).toHaveLength(1));
    expect(mocks.claimFolderSync).toHaveBeenCalledWith("user_me");
  });

});

describe("FolderSyncCard: Chrome and Edge", () => {
  it("asks for a folder in Chrome and Edge and says when it syncs", async () => {
    Object.defineProperty(window, "showDirectoryPicker", { value: vi.fn(), configurable: true });
    render(<FolderSyncCard />);
    expect(await screen.findByRole("button", { name: "Choose your StarCraft II folder" })).toBeTruthy();
    expect(screen.getByText(/Each time you open or return to your SC2 Tools dashboard \(at most every 10 minutes\)/)).toBeTruthy();
    expect(screen.getByText("Chrome & Edge")).toBeTruthy();
  });

  it("re-grants access inside the Resume click, then syncs", async () => {
    Object.defineProperty(window, "showDirectoryPicker", { value: vi.fn(), configurable: true });
    const handle = mockHandle("prompt");
    mocks.handle = handle;
    render(<FolderSyncCard />);
    const resume = await screen.findByRole("button", { name: "Resume sync" });
    expect(screen.getByText(/4 replays synced from this folder/)).toBeTruthy();

    fireEvent.click(resume);
    expect(handle.requestPermission).toHaveBeenCalledTimes(1);
    await waitFor(() => expect(mocks.runs).toHaveLength(1));
    expect(mocks.gaEvent).toHaveBeenCalledWith("instant_folder_sync_resume");
    expect(await screen.findByText("Added to your account")).toBeTruthy();
  });

  it("forgets the folder and its ledger after confirming Stop syncing", async () => {
    Object.defineProperty(window, "showDirectoryPicker", { value: vi.fn(), configurable: true });
    mocks.handle = mockHandle("granted");
    render(<FolderSyncCard />);
    fireEvent.click(await screen.findByRole("button", { name: "Stop syncing" }));
    await screen.findByRole("dialog");
    await confirmIn("Stop syncing");
    expect(mocks.clearFolderHandle).toHaveBeenCalledTimes(1);
    expect(mocks.clearLedger).toHaveBeenCalledTimes(1);
    expect(await screen.findByRole("button", { name: "Choose your StarCraft II folder" })).toBeTruthy();
  });

});

describe("FolderSyncCard: account binding and permission", () => {
  it("never offers to sync a folder remembered for another account until this account claims it", async () => {
    Object.defineProperty(window, "showDirectoryPicker", { value: vi.fn(), configurable: true });
    mocks.handle = mockHandle("granted");
    mocks.owner = "user_other";
    render(<FolderSyncCard />);
    const claim = await screen.findByRole("button", { name: "Use this folder for this account" });
    expect(screen.getByText(/set up by another account/)).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Sync now" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Resume sync" })).toBeNull();

    fireEvent.click(claim);
    await waitFor(() => expect(mocks.claimFolderSync).toHaveBeenCalledWith("user_me"));
    expect(await screen.findByRole("button", { name: "Sync now" })).toBeTruthy();
    expect(screen.getByText(/0 replays synced from this folder/)).toBeTruthy();
    expect(mocks.runs).toHaveLength(0);
  });

  it("treats a remembered folder without an owner as another account's", async () => {
    Object.defineProperty(window, "showDirectoryPicker", { value: vi.fn(), configurable: true });
    mocks.handle = mockHandle("granted");
    mocks.owner = null;
    render(<FolderSyncCard />);
    expect(await screen.findByRole("button", { name: "Use this folder for this account" })).toBeTruthy();
  });

  it("reports a refused re-grant as folder_permission_denied", async () => {
    Object.defineProperty(window, "showDirectoryPicker", { value: vi.fn(), configurable: true });
    const handle = mockHandle("prompt");
    handle.requestPermission.mockResolvedValue("denied");
    mocks.handle = handle;
    render(<FolderSyncCard />);
    fireEvent.click(await screen.findByRole("button", { name: "Resume sync" }));
    await waitFor(() => expect(mocks.gaEvent).toHaveBeenCalledWith("instant_error", { kind: "folder_permission_denied" }));
    expect(mocks.runs).toHaveLength(0);
  });

  it("reports a picker the browser refused as folder_permission_denied", async () => {
    const picker = vi.fn(async () => {
      throw new DOMException("blocked", "NotAllowedError");
    });
    Object.defineProperty(window, "showDirectoryPicker", { value: picker, configurable: true });
    render(<FolderSyncCard />);
    fireEvent.click(await screen.findByRole("button", { name: "Choose your StarCraft II folder" }));
    expect(await screen.findByText(/Access to that folder was blocked/)).toBeTruthy();
    expect(mocks.gaEvent).toHaveBeenCalledWith("instant_error", { kind: "folder_permission_denied" });
  });
});

describe("FolderSyncCard: last result", () => {
  it("points to the right folder when the chosen one has no ladder replays", async () => {
    Object.defineProperty(window, "showDirectoryPicker", { value: vi.fn(), configurable: true });
    mocks.handle = mockHandle("granted");
    mocks.pass = async () => EMPTY_RUN;
    render(<FolderSyncCard />);
    fireEvent.click(await screen.findByRole("button", { name: "Sync now" }));
    expect(await screen.findByText(/No ladder replays found in that folder/)).toBeTruthy();
    expect(screen.queryByText("No new replays since the last check.")).toBeNull();
  });

  it("says a sync was cancelled even when it stopped before uploading", async () => {
    Object.defineProperty(window, "showDirectoryPicker", { value: vi.fn(), configurable: true });
    mocks.handle = mockHandle("granted");
    mocks.pass = (input) =>
      new Promise((resolve) => {
        input.signal?.addEventListener("abort", () => resolve({ ...EMPTY_RUN, found: 5, newFiles: 3, aborted: true }));
      });
    render(<FolderSyncCard />);
    fireEvent.click(await screen.findByRole("button", { name: "Sync now" }));
    expect(mocks.runs).toHaveLength(1);
    const signal = mocks.runs[0].signal;
    expect(signal?.aborted).toBe(false);
    fireEvent.click(await screen.findByRole("button", { name: "Stop this sync" }));
    expect(signal?.aborted).toBe(true);
    expect(await screen.findByRole("heading", { name: "Upload cancelled" })).toBeTruthy();
    expect(mocks.runs).toHaveLength(1);
  });
});
