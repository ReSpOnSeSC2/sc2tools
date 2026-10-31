import { IDBFactory } from "fake-indexeddb";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { deviceClearMark, forgetDeviceCopy, mayHaveApplied } from "../deviceClear";
import { DEVICE_CORPUS_DB_NAME, DEVICE_DELETE_OWED_KEY } from "../deviceKeys";
import { mayHaveDeviceCopy, noteDeviceCopy } from "../deviceNote";
import { openDeviceCorpus, saveDeviceSnapshot } from "../deviceStore";

const MARKS = { corpusVersion: 1, watermark: "2026-10-31T10:00:00.000Z", corpusEpoch: "1.0123456789abcdef" };
const owed = () => window.localStorage.getItem(DEVICE_DELETE_OWED_KEY);

beforeEach(() => {
  window.localStorage.clear();
});

afterEach(() => {
  vi.restoreAllMocks();
});

async function untilNoDatabases(factory: IDBFactory) {
  for (let tries = 0; tries < 50 && (await factory.databases()).length > 0; tries += 1) {
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  return factory.databases();
}

/** A factory whose deletes are queued and finish only when a test fires them, recording the clear mark at each one. */
function stalledFactory() {
  const marksAtDelete: Array<string | null> = [];
  const requests: IDBOpenDBRequest[] = [];
  const deleteDatabase = vi.fn(() => {
    marksAtDelete.push(deviceClearMark());
    const request = {} as IDBOpenDBRequest;
    requests.push(request);
    return request;
  });
  return { factory: { deleteDatabase } as unknown as IDBFactory, deleteDatabase, marksAtDelete, requests };
}

describe("forgetDeviceCopy", () => {
  it("forgets the note, deletes the database and moves the clear mark, owing the delete until it finishes", async () => {
    const factory = new IDBFactory();
    const db = await openDeviceCorpus(factory, { create: true });
    await saveDeviceSnapshot(db!, "user-a", [{ gameId: "g1" }], MARKS, 10);
    db!.close();
    noteDeviceCopy("user-a");
    const before = deviceClearMark();

    forgetDeviceCopy(factory);
    const first = deviceClearMark();
    expect([first === before, first === null, mayHaveDeviceCopy("user-a"), owed() === first]).toEqual([false, false, false, true]);
    expect(await untilNoDatabases(factory)).toEqual([]);
    await vi.waitFor(() => expect(owed()).toBeNull());

    forgetDeviceCopy(factory);
    expect(deviceClearMark()).not.toBe(first);
  });

  it("lets a finished delete settle only its own clear, not a newer one still owed", async () => {
    const factory = new IDBFactory();
    const deleteDatabase = factory.deleteDatabase.bind(factory);
    let finished: Promise<void> | undefined;
    vi.spyOn(factory, "deleteDatabase").mockImplementationOnce((name: string) => {
      const request = deleteDatabase(name);
      finished = new Promise((resolve) => request.addEventListener("success", () => resolve()));
      return request;
    });
    forgetDeviceCopy(factory);
    forgetDeviceCopy(stalledFactory().factory);
    const newer = deviceClearMark();
    await finished;
    expect(owed()).toBe(newer);
  });

  it("keeps a delete owed when it fails, and settles it when it succeeds", () => {
    const stalled = stalledFactory();
    forgetDeviceCopy(stalled.factory);
    const mark = deviceClearMark();
    const [request] = stalled.requests;
    request.onerror!.call(request, { preventDefault: vi.fn() } as unknown as Event);
    expect(owed()).toBe(mark);
    request.onsuccess!.call(request, new Event("success"));
    expect(owed()).toBeNull();
  });

  it("queues the delete before the mark moves, and keeps it owed while it has not finished", () => {
    const before = deviceClearMark();
    const stalled = stalledFactory();
    forgetDeviceCopy(stalled.factory);
    expect([stalled.marksAtDelete, stalled.deleteDatabase.mock.calls, owed() === deviceClearMark()])
      .toEqual([[before], [[DEVICE_CORPUS_DB_NAME]], true]);
  });

  it("still forgets the note and deletes the database when storage is too full to move the mark", () => {
    noteDeviceCopy("user-a");
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new DOMException("full", "QuotaExceededError");
    });
    const stalled = stalledFactory();
    forgetDeviceCopy(stalled.factory);
    expect([mayHaveDeviceCopy("user-a"), stalled.deleteDatabase.mock.calls]).toEqual([false, [[DEVICE_CORPUS_DB_NAME]]]);
  });

  it("owes nothing and does nothing harmful without IndexedDB or storage", () => {
    vi.stubGlobal("indexedDB", undefined);
    expect(() => forgetDeviceCopy()).not.toThrow();
    vi.unstubAllGlobals();
    const refused = { deleteDatabase: vi.fn(() => { throw new DOMException("denied", "SecurityError"); }) } as unknown as IDBFactory;
    forgetDeviceCopy(refused);
    expect(owed()).toBeNull();
    const before = deviceClearMark();
    const spies = (["getItem", "setItem", "removeItem"] as const).map((method) => vi.spyOn(Storage.prototype, method)
      .mockImplementation(() => {
        throw new DOMException("denied", "SecurityError");
      }));
    expect(() => forgetDeviceCopy(refused)).not.toThrow();
    for (const spy of spies) spy.mockRestore();
    // With storage refused nothing was written: the mark is where the last clear left it.
    expect(deviceClearMark()).toBe(before);
  });
});

describe("mayHaveApplied", () => {
  it("counts only a definite rejection as a request that changed nothing", () => {
    const failures = [{ status: 400 }, { status: 404 }, { status: 409 }, { status: 499 }, { status: 500 }, { status: 502 },
      { status: 0 }, new TypeError("Failed to fetch"), new Error("offline"), undefined, null];
    expect(failures.map(mayHaveApplied)).toEqual([false, false, false, false, true, true, true, true, true, true, true]);
    // Offline by the time the failure arrives: the request may have left before the connection dropped.
    vi.spyOn(window.navigator, "onLine", "get").mockReturnValue(false);
    expect(mayHaveApplied(new TypeError("Failed to fetch"))).toBe(true);
  });
});
