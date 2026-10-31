import { IDBFactory } from "fake-indexeddb";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { deviceClearMark, forgetDeviceCopy } from "../deviceClear";
import { DEVICE_CORPUS_DB_NAME } from "../deviceKeys";
import { mayHaveDeviceCopy, noteDeviceCopy } from "../deviceNote";
import { openDeviceCorpus, saveDeviceSnapshot } from "../deviceStore";

const MARKS = { corpusVersion: 1, watermark: "2026-10-31T10:00:00.000Z", corpusEpoch: "1.0123456789abcdef" };

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

describe("forgetDeviceCopy", () => {
  it("forgets the note, moves the clear mark and deletes the database", async () => {
    const factory = new IDBFactory();
    const db = await openDeviceCorpus(factory, { create: true });
    await saveDeviceSnapshot(db!, "user-a", [{ gameId: "g1" }], MARKS, 10);
    db!.close();
    noteDeviceCopy("user-a");
    const before = deviceClearMark();

    forgetDeviceCopy(factory);
    const first = deviceClearMark();
    expect([first === before, first === null, mayHaveDeviceCopy("user-a")]).toEqual([false, false, false]);
    expect(await untilNoDatabases(factory)).toEqual([]);

    forgetDeviceCopy(factory);
    expect(deviceClearMark()).not.toBe(first);
  });

  it("still forgets the note and deletes the database when storage is too full to move the mark", () => {
    noteDeviceCopy("user-a");
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new DOMException("full", "QuotaExceededError");
    });
    const factory = { deleteDatabase: vi.fn(() => ({}) as IDBOpenDBRequest) };
    forgetDeviceCopy(factory as unknown as IDBFactory);
    expect([mayHaveDeviceCopy("user-a"), factory.deleteDatabase.mock.calls]).toEqual([false, [[DEVICE_CORPUS_DB_NAME]]]);
  });

  it("does nothing harmful without IndexedDB or storage", () => {
    expect(() => forgetDeviceCopy(undefined)).not.toThrow();
    for (const method of ["getItem", "setItem", "removeItem"] as const) {
      vi.spyOn(Storage.prototype, method).mockImplementation(() => {
        throw new DOMException("denied", "SecurityError");
      });
    }
    const factory = { deleteDatabase: vi.fn(() => { throw new DOMException("denied", "SecurityError"); }) } as unknown as IDBFactory;
    expect(() => forgetDeviceCopy(factory)).not.toThrow();
    expect(deviceClearMark()).toBeNull();
  });
});
