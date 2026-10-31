import { cleanup, render, waitFor } from "@testing-library/react";
import { IDBFactory } from "fake-indexeddb";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const auth = vi.hoisted(() => ({ isLoaded: true, isSignedIn: true, userId: "user-a" as string | null }));
const forget = vi.hoisted(() => ({ loads: 0, calls: 0 }));

vi.mock("@clerk/nextjs", () => ({ useAuth: () => auth }));
vi.mock("@/lib/analysisCorpus/deviceClear", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/analysisCorpus/deviceClear")>();
  const counted = (...args: Parameters<typeof actual.forgetDeviceCopy>) => {
    forget.calls += 1;
    actual.forgetDeviceCopy(...args);
  };
  return {
    ...actual,
    // Reading the export marks the moment the guard's on-demand import arrived.
    get forgetDeviceCopy() {
      forget.loads += 1;
      return counted;
    },
  };
});

import { DeviceHistoryGuard } from "../DeviceHistoryGuard";
import { DEVICE_CLEAR_KEY, DEVICE_DELETE_OWED_KEY, DEVICE_NOTE_KEY } from "@/lib/analysisCorpus/deviceKeys";
import { mayHaveDeviceCopy, noteDeviceCopy } from "@/lib/analysisCorpus/deviceNote";
import { openDeviceCorpus, saveDeviceSnapshot } from "@/lib/analysisCorpus/deviceStore";

const MARKS = { corpusVersion: 1, watermark: "2026-10-31T10:00:00.000Z", corpusEpoch: "1.0123456789abcdef" };
let factory: IDBFactory;

beforeEach(() => {
  factory = new IDBFactory();
  vi.stubGlobal("indexedDB", factory);
  window.localStorage.clear();
  Object.assign(forget, { loads: 0, calls: 0 });
  Object.assign(auth, { isLoaded: true, isSignedIn: true, userId: "user-a" });
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

/** An account's rows on the device; `noted` also writes the note a keep leaves. */
async function rows(accountKey: string, { noted = true } = {}) {
  const db = await openDeviceCorpus(factory, { create: true });
  await saveDeviceSnapshot(db!, accountKey, [{ gameId: "g1" }], MARKS, 10);
  db!.close();
  if (noted) noteDeviceCopy(accountKey);
}

/** Wait until the guard's on-demand import, if it started one, has arrived and run (the module is cached first). */
async function settle() {
  await import("@/lib/analysisCorpus/deviceClear");
  await vi.dynamicImportSettled();
}

async function untilNoDatabases() {
  for (let tries = 0; tries < 50 && (await factory.databases()).length > 0; tries += 1) {
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  return factory.databases();
}

describe("DeviceHistoryGuard", () => {
  it("keeps the signed-in account's own copy", async () => {
    await rows("user-a");
    render(<DeviceHistoryGuard />);
    await settle();
    expect([forget.loads, mayHaveDeviceCopy("user-a"), (await factory.databases()).length]).toEqual([0, true, 1]);
  });

  it("removes the copy once nobody is signed in", async () => {
    await rows("user-a");
    Object.assign(auth, { isSignedIn: false, userId: null });
    render(<DeviceHistoryGuard />);
    await waitFor(() => expect(mayHaveDeviceCopy("user-a")).toBe(false));
    expect(forget.calls).toBe(1);
    expect(await untilNoDatabases()).toEqual([]);
  });

  it("removes the previous account's copy when another account signs in", async () => {
    await rows("user-a");
    const view = render(<DeviceHistoryGuard />);
    await settle();
    expect(forget.loads).toBe(0);
    auth.userId = "user-b";
    view.rerender(<DeviceHistoryGuard />);
    await waitFor(() => expect(forget.calls).toBe(1));
    expect(mayHaveDeviceCopy("user-a")).toBe(false);
    expect(await untilNoDatabases()).toEqual([]);
  });

  it("does nothing before Clerk loads, or for a signed-in account when no copy is noted", async () => {
    await rows("user-a");
    Object.assign(auth, { isLoaded: false, isSignedIn: false, userId: null });
    const view = render(<DeviceHistoryGuard />);
    await settle();
    expect([forget.loads, mayHaveDeviceCopy("user-a")]).toEqual([0, true]);

    window.localStorage.removeItem(DEVICE_NOTE_KEY);
    Object.assign(auth, { isLoaded: true, isSignedIn: true, userId: "user-b" });
    view.rerender(<DeviceHistoryGuard />);
    await settle();
    expect([forget.loads, (await factory.databases()).length]).toEqual([0, 1]);
  });

  it("issues an earlier clear's delete again while no note stands, until it is seen to finish", async () => {
    await rows("user-a", { noted: false });
    window.localStorage.setItem(DEVICE_DELETE_OWED_KEY, "an-earlier-clear");
    auth.userId = "user-b";
    render(<DeviceHistoryGuard />);
    await waitFor(() => expect(forget.calls).toBe(1));
    expect(await untilNoDatabases()).toEqual([]);
    await waitFor(() => expect(window.localStorage.getItem(DEVICE_DELETE_OWED_KEY)).toBeNull());
  });

  it("leaves an owed delete alone while the signed-in account's note stands, since a keep came after it", async () => {
    await rows("user-a");
    window.localStorage.setItem(DEVICE_DELETE_OWED_KEY, "an-earlier-clear");
    render(<DeviceHistoryGuard />);
    await settle();
    expect([forget.loads, (await factory.databases()).length]).toEqual([0, 1]);
  });

  it("deletes a copy left from before when the note cannot be read, since no copy is kept without one", async () => {
    await rows("user-a");
    vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
      throw new DOMException("denied", "SecurityError");
    });
    render(<DeviceHistoryGuard />);
    expect(await untilNoDatabases()).toEqual([]);
    expect(forget.loads).toBe(0);
  });

  it("keeps a copy that this account noted while the clearing code loaded", async () => {
    noteDeviceCopy("user-a");
    auth.userId = "user-b";
    render(<DeviceHistoryGuard />);
    // Another tab starts keeping user-b's history before the clearing code arrives.
    noteDeviceCopy("user-b");
    await waitFor(() => expect(forget.loads).toBe(1));
    expect([forget.calls, mayHaveDeviceCopy("user-b")]).toEqual([0, true]);
  });

  // The last two replace the clearing module for every later import in this file.
  it("still removes the copy when the clearing code cannot load, and owes its delete to a later page", async () => {
    await rows("user-a");
    Object.assign(auth, { isSignedIn: false, userId: null });
    const mark = window.localStorage.getItem(DEVICE_CLEAR_KEY);
    failClearingModule();
    render(<DeviceHistoryGuard />);
    await waitFor(() => expect(mayHaveDeviceCopy("user-a")).toBe(false));
    const moved = window.localStorage.getItem(DEVICE_CLEAR_KEY);
    expect([forget.loads, moved === mark, window.localStorage.getItem(DEVICE_DELETE_OWED_KEY) === moved]).toEqual([0, false, true]);
    expect(await untilNoDatabases()).toEqual([]);
  });

  it("keeps a copy that this account noted while the clearing code failed to load", async () => {
    noteDeviceCopy("user-a");
    auth.userId = "user-b";
    const deletes = vi.spyOn(factory, "deleteDatabase");
    const failures = failClearingModule();
    render(<DeviceHistoryGuard />);
    // Another tab starts keeping user-b's history before the failed load settles.
    noteDeviceCopy("user-b");
    await vi.waitFor(() => expect(failures.count).toBe(1));
    for (let tick = 0; tick < 5; tick += 1) await new Promise((resolve) => setTimeout(resolve, 0));
    expect([mayHaveDeviceCopy("user-b"), deletes.mock.calls.length]).toEqual([true, 0]);
  });
});

/** Make the guard's next import of the clearing code fail, as a chunk a deploy replaced would. */
function failClearingModule() {
  const failures = { count: 0 };
  vi.resetModules();
  vi.doMock("@/lib/analysisCorpus/deviceClear", () => {
    failures.count += 1;
    throw new Error("The chunk was replaced by a deploy");
  });
  return failures;
}
