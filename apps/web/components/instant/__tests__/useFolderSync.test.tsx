/** First committed folder-ready actions use the hydrated snapshot, with mocked storage and runner. */
import { useLayoutEffect, useRef } from "react";
import { act, cleanup, render } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import type { FolderSyncInput } from "@/lib/instant/folderSyncRunner";
import { useFolderSync } from "../useFolderSync";

const mocks = vi.hoisted(() => ({
  handle: {
    kind: "directory" as const,
    name: "StarCraft II",
    values: () => ({ async *[Symbol.asyncIterator]() {} }),
    queryPermission: async () => "granted" as const,
    requestPermission: vi.fn(async () => "granted" as const),
  },
  getToken: vi.fn(async () => "fixture-token"),
  runs: [] as FolderSyncInput[],
  layoutAttempts: [] as { loaded: boolean; folderName: string | null; permission: string | null }[],
}));

vi.mock("@/lib/analytics/gtag", () => ({ gaEvent: vi.fn() }));
vi.mock("@clerk/nextjs", () => ({ useAuth: () => ({ getToken: mocks.getToken, userId: "fixture-user" }) }));
vi.mock("@/lib/clientApi", () => ({ API_BASE: "https://api.test", apiCall: vi.fn() }));
vi.mock("@/lib/instant/localStore", () => ({
  loadFolderHandle: async () => mocks.handle,
  getFolderOwner: async () => "fixture-user",
  getLastFolderScanAt: async () => null,
  saveFolderHandle: async () => undefined,
  clearFolderHandle: async () => undefined,
  clearLedger: async () => undefined,
  claimFolderSync: async () => undefined,
}));
vi.mock("@/lib/instant/folderSyncRunner", () => ({
  fetchProfileToons: async () => [],
  folderLedgerCounts: async () => ({ synced: 0, total: 0 }),
  runFolderSyncExclusive: async (input: FolderSyncInput) => {
    mocks.runs.push(input);
    return { found: 0, newFiles: 0, processed: 0, failed: [], aborted: false, engineStarted: false,
      uploaded: 0, created: 0, skippedExisting: 0, rejected: 0, pending: 0 };
  },
}));

function CommittedReadyAction() {
  const { loaded, permission, folderName, syncNow } = useFolderSync();
  const attempted = useRef(false);
  useLayoutEffect(() => {
    if (!loaded || permission !== "granted" || !folderName || attempted.current) return;
    attempted.current = true;
    mocks.layoutAttempts.push({ loaded, folderName, permission });
    syncNow();
  }, [loaded, permission, folderName, syncNow]);
  return null;
}

afterEach(() => {
  cleanup();
  Reflect.deleteProperty(window, "showDirectoryPicker");
});

it("starts exactly one sync from the first committed ready state before passive effects", async () => {
  Object.defineProperty(window, "showDirectoryPicker", { value: vi.fn(), configurable: true });
  await act(async () => { render(<CommittedReadyAction />); });
  expect(mocks.layoutAttempts).toEqual([{ loaded: true, folderName: "StarCraft II", permission: "granted" }]);
  expect(mocks.runs).toHaveLength(1);
  expect(mocks.runs[0].ownerUserId).toBe("fixture-user");
  const source = mocks.runs[0].source;
  expect("handle" in source && source.handle).toBe(mocks.handle);
  expect(mocks.handle.requestPermission).not.toHaveBeenCalled();
});
