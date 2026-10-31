import { IDBFactory } from "fake-indexeddb";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  deviceClearMark,
  forgetDeviceCopy,
  mayHaveDeviceCopy,
  noteDeviceCopy,
} from "../deviceNote";
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

describe("the device note", () => {
  it("names one account, forgets it with null, and reports a write that reads would not see", () => {
    expect(mayHaveDeviceCopy("user-a")).toBe(false);
    expect(noteDeviceCopy("user-a")).toBe(true);
    expect([mayHaveDeviceCopy("user-a"), mayHaveDeviceCopy("user-b")]).toEqual([true, false]);
    expect(noteDeviceCopy(null)).toBe(true);
    expect(mayHaveDeviceCopy("user-a")).toBe(false);

    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new DOMException("full", "QuotaExceededError");
    });
    expect(noteDeviceCopy("user-a")).toBe(false);
  });

  it("treats a note that cannot be read as a reason to probe", () => {
    vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
      throw new DOMException("denied", "SecurityError");
    });
    expect([mayHaveDeviceCopy("user-a"), deviceClearMark()]).toEqual([true, null]);
  });
});

describe("forgetDeviceCopy", () => {
  it("moves the clear mark, forgets the note and deletes the database", async () => {
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

  it("does nothing harmful without IndexedDB or storage", () => {
    expect(() => forgetDeviceCopy(undefined)).not.toThrow();
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new DOMException("denied", "SecurityError");
    });
    const factory = { deleteDatabase: vi.fn(() => { throw new DOMException("denied", "SecurityError"); }) } as unknown as IDBFactory;
    expect(() => forgetDeviceCopy(factory)).not.toThrow();
  });
});
