import { IDBDatabase as FakeIDBDatabase, IDBFactory } from "fake-indexeddb";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { idbTransactionOn } from "@/lib/instant/idb";
import { forgetDeviceCopy } from "@/lib/analysisCorpus/deviceClear";
import { mayHaveDeviceCopy, noteDeviceCopy } from "@/lib/analysisCorpus/deviceNote";
import {
  openDeviceCorpus,
  readDeviceCorpus,
  saveDeviceSnapshot,
} from "@/lib/analysisCorpus/deviceStore";
import {
  syncAnalysisCorpus,
  type CorpusSyncInput,
} from "../hooks/analysisCorpusSync";
import type { AnalysisApiGame, RawAnalysisSnapshot } from "../hooks/useAnalysisGames";

const EPOCH = "1.0123456789abcdef";
const MARKS = { corpusVersion: 1, watermark: "2026-10-31T10:00:00.000Z", corpusEpoch: EPOCH };
const NEXT = { ...MARKS, watermark: "2026-10-31T11:00:00.000Z" };
const REFUSED = { snapshotRequired: "corpus_version", corpusVersion: 2, corpusEpoch: EPOCH };
let factory: IDBFactory;

// Lets a test hold a device save while it checks what already happened.
const saveGate = vi.hoisted(() => ({ hold: null as null | (() => Promise<void>) }));

vi.mock("@/lib/analysisCorpus/deviceStore", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/analysisCorpus/deviceStore")>();
  return {
    ...actual,
    saveDeviceSnapshot: async (...args: Parameters<typeof actual.saveDeviceSnapshot>) => {
      await saveGate.hold?.();
      return actual.saveDeviceSnapshot(...args);
    },
  };
});

beforeEach(() => {
  factory = new IDBFactory();
  vi.stubGlobal("indexedDB", factory);
  window.localStorage.clear();
  saveGate.hold = null;
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

function game(gameId: string, date = "2026-10-31T09:00:00.000Z"): AnalysisApiGame {
  return { gameId, date, result: "Victory" } as AnalysisApiGame;
}

type Snapshot = { rows?: Array<string | AnalysisApiGame>; firstPage?: unknown; pageEpochs?: unknown[]; hitCorpusLimit?: boolean };

/** A server whose changes route answers `changes` and whose snapshot is `snapshot` (or throws it, when an Error). */
function input(
  changes: unknown,
  snapshot: Snapshot | Error = {},
  overrides: Partial<Omit<CorpusSyncInput, "fetchPage" | "readSnapshot" | "onStored" | "onSnapshot">> = {},
) {
  const fetchPage = vi.fn(async (_path: string): Promise<unknown> => {
    if (changes instanceof Error) throw changes;
    return changes;
  });
  const readSnapshot = vi.fn(async (): Promise<RawAnalysisSnapshot> => {
    if (snapshot instanceof Error) throw snapshot;
    const items = (snapshot.rows ?? []).map((row) => (typeof row === "string" ? game(row) : row));
    return {
      items, pagesFetched: 1, hitCorpusLimit: snapshot.hitCorpusLimit ?? false,
      firstPage: "firstPage" in snapshot ? snapshot.firstPage : MARKS, pageEpochs: snapshot.pageEpochs ?? [EPOCH],
    };
  });
  return {
    accountKey: "user-a", keepOnDevice: false, signal: new AbortController().signal, maxRows: 100, pageSize: 2, maxPages: 10,
    ...overrides, fetchPage, readSnapshot, onStored: vi.fn(), onSnapshot: vi.fn(),
  } satisfies CorpusSyncInput;
}

async function keep(rows: Array<string | AnalysisApiGame>, marks = MARKS, accountKey = "user-a") {
  const hold = saveGate.hold;
  saveGate.hold = null;
  const db = await openDeviceCorpus(factory, { create: true });
  await saveDeviceSnapshot(db!, accountKey, rows.map((row) => (typeof row === "string" ? game(row) : row)), marks, 100);
  db!.close();
  saveGate.hold = hold;
}

async function copy(accountKey = "user-a") {
  const db = await openDeviceCorpus(factory, { create: false });
  if (!db) return "none";
  const stored = await readDeviceCorpus<AnalysisApiGame>(db, accountKey, 100);
  db.close();
  return stored.kind === "stored"
    ? { marks: stored.marks, ids: stored.rows.map((row) => row.gameId).sort() }
    : stored.kind;
}

const ids = (rows: Array<{ gameId: string }>) => rows.map((row) => row.gameId);

/** Stands in for another tab's clear: the delete is left out, so a test can see what was written after the clear. */
const leaveDatabase = () => ({ deleteDatabase: vi.fn() }) as unknown as IDBFactory;

/** Another tab clears the copy while this sync opens the device. */
function clearWhileOpening() {
  const open = factory.open.bind(factory);
  vi.spyOn(factory, "open").mockImplementation((...args: Parameters<IDBFactory["open"]>) => {
    forgetDeviceCopy(leaveDatabase());
    return open(...args);
  });
}

async function untilNoDatabases() {
  for (let tries = 0; tries < 50 && (await factory.databases()).length > 0; tries += 1) {
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  return factory.databases();
}

describe("syncAnalysisCorpus", () => {
  it("loads in memory only when IndexedDB is unavailable, even when asked to keep a copy", async () => {
    vi.stubGlobal("indexedDB", undefined);
    const sync = input(null, { rows: ["a"] }, { keepOnDevice: true });
    const synced = await syncAnalysisCorpus(sync);
    expect([synced.onDevice, synced.kept, ids(synced.items), mayHaveDeviceCopy("user-a")]).toEqual([false, false, ["a"], false]);
    expect(sync.onSnapshot).not.toHaveBeenCalled();
  });

  it("creates nothing on the device for an account that did not ask to keep a copy", async () => {
    const synced = await syncAnalysisCorpus(input(null, { rows: ["a"] }));
    expect([synced.onDevice, synced.kept, ids(synced.items)]).toEqual([false, false, ["a"]]);
    expect(await factory.databases()).toEqual([]);
  });

  it("shows the stored copy newest first before bringing it up to date", async () => {
    // Stored rows come back in key order (by game id), the opposite of their dates here.
    await keep([game("a-older", "2026-10-29T00:00:00.000Z"), game("b-newer", "2026-10-30T00:00:00.000Z")]);
    const sync = input({ items: [], nextCursor: null, ...NEXT });
    const synced = await syncAnalysisCorpus(sync);
    expect(ids(sync.onStored.mock.calls[0][0].items)).toEqual(["b-newer", "a-older"]);
    expect([synced.onDevice, synced.kept, synced.marks]).toEqual([true, true, NEXT]);
    expect(sync.readSnapshot).not.toHaveBeenCalled();
  });

  it("replaces an unreadable copy with a snapshot without showing it", async () => {
    await keep(["a", "b"]);
    const db = await openDeviceCorpus(factory, { create: false });
    await idbTransactionOn(db!, "games", "readwrite", (tx) => { tx.objectStore("games").delete(["user-a", "b"]); });
    db!.close();
    const sync = input(null, { rows: ["fresh"] });
    const synced = await syncAnalysisCorpus(sync);
    expect(sync.onStored).not.toHaveBeenCalled();
    expect(ids(sync.onSnapshot.mock.calls[0][0].items)).toEqual(["fresh"]);
    expect(synced.onDevice).toBe(true);
    expect(await copy()).toEqual({ marks: MARKS, ids: ["fresh"] });
  });

  it("merges a delta that lands exactly on the row limit, and takes a snapshot past it", async () => {
    await keep(["a", "b"]);
    const atLimit = input({ items: [game("c")], nextCursor: null, ...NEXT }, {}, { maxRows: 3 });
    expect(ids((await syncAnalysisCorpus(atLimit)).items).sort()).toEqual(["a", "b", "c"]);
    expect(atLimit.readSnapshot).not.toHaveBeenCalled();

    const pastLimit = input({ items: [game("d")], nextCursor: null, ...NEXT, watermark: "2026-10-31T12:00:00.000Z" },
      { rows: ["s1", "s2"] }, { maxRows: 3 });
    expect(ids((await syncAnalysisCorpus(pastLimit)).items)).toEqual(["s1", "s2"]);
    expect(pastLimit.readSnapshot).toHaveBeenCalledTimes(1);
    expect(await copy()).toEqual({ marks: MARKS, ids: ["s1", "s2"] });
  });

  it("drops the copy past the corpus ceiling, keeping the account's choice", async () => {
    await keep(["a"]);
    const synced = await syncAnalysisCorpus(input(REFUSED, { rows: ["s1", "s2"], hitCorpusLimit: true }, { maxRows: 2 }));
    expect([synced.hitCorpusLimit, synced.onDevice, synced.kept]).toEqual([true, false, true]);
    expect(await copy()).toBe("kept");
  });

  it("drops a copy that a snapshot without marks could not replace, then stores the next snapshot", async () => {
    await keep(["a"]);
    const missing = Object.assign(new Error("Not found"), { status: 404 });
    const synced = await syncAnalysisCorpus(input(missing, { rows: ["s1"], firstPage: {}, pageEpochs: [undefined] }));
    expect([synced.onDevice, synced.marks, ids(synced.items)]).toEqual([false, null, ["s1"]]);
    expect(await copy()).toBe("kept");
    const next = input(null, { rows: ["s2"] });
    const after = await syncAnalysisCorpus(next);
    expect([next.onStored.mock.calls.length, next.fetchPage.mock.calls.length, after.onDevice]).toEqual([0, 0, true]);
    expect(await copy()).toEqual({ marks: MARKS, ids: ["s2"] });
  });

  it("never keeps a snapshot whose pages came from two corpus epochs, or did not all report one", async () => {
    const synced = await syncAnalysisCorpus(input(null, { rows: ["s1", "s2"], pageEpochs: [EPOCH, "2.fedcba9876543210"] },
      { keepOnDevice: true }));
    expect([synced.onDevice, synced.marks, synced.kept]).toEqual([false, null, true]);
    expect(await copy()).toBe("kept");
    const short = input(null, { rows: ["s1", "s2"], pageEpochs: [EPOCH] }, { keepOnDevice: true });
    short.readSnapshot.mockImplementation(async () => ({
      items: [game("s1"), game("s2")], pagesFetched: 2, hitCorpusLimit: false, firstPage: MARKS, pageEpochs: [EPOCH],
    }));
    expect((await syncAnalysisCorpus(short)).marks).toBeNull();
    expect(await copy()).toBe("kept");
  });

  it("drops a refused copy before the snapshot, so a failed snapshot cannot leave it in place", async () => {
    await keep(["pre-wipe"]);
    const busy = Object.assign(new Error("busy"), { status: 503 });
    await expect(syncAnalysisCorpus(input(REFUSED, busy))).rejects.toBe(busy);
    expect(await copy()).toBe("kept");
  });

  it("drops the old copy when the snapshot that should replace it cannot be saved", async () => {
    await keep(["pre-wipe"]);
    // A row that cannot be stored makes the replacing save fail, as a full disk would.
    const unstorable = { ...game("post-wipe"), detail: () => undefined } as unknown as AnalysisApiGame;
    const sync = input(REFUSED, { rows: [unstorable] });
    const synced = await syncAnalysisCorpus(sync);
    expect(ids(sync.onSnapshot.mock.calls[0][0].items)).toEqual(["post-wipe"]);
    expect([synced.onDevice, synced.kept, ids(synced.items)]).toEqual([false, true, ["post-wipe"]]);
    expect(await copy()).toBe("kept");
  });

  it("deletes the database when a stale copy can be neither replaced nor dropped", async () => {
    await keep(["pre-wipe"]);
    const transaction = FakeIDBDatabase.prototype.transaction;
    vi.spyOn(FakeIDBDatabase.prototype, "transaction").mockImplementation(function (this: IDBDatabase, ...args) {
      if (args[1] === "readwrite") throw new Error("storage full");
      return transaction.apply(this, args as Parameters<typeof transaction>);
    });
    const synced = await syncAnalysisCorpus(input(REFUSED, { rows: ["post-wipe"] }));
    vi.restoreAllMocks();
    expect([synced.onDevice, synced.kept]).toEqual([false, false]);
    expect(await untilNoDatabases()).toEqual([]);
  });

  it("writes nothing to the device once its run is cancelled", async () => {
    await keep(["a", "b"]);
    const run = new AbortController();
    const sync = input(null, {}, { signal: run.signal });
    sync.fetchPage.mockImplementation(async () => {
      run.abort();
      return { items: [{ gameId: "b", removed: true }], nextCursor: null, ...NEXT };
    });
    await expect(syncAnalysisCorpus(sync)).rejects.toMatchObject({ name: "AbortError" });
    expect(await copy()).toEqual({ marks: MARKS, ids: ["a", "b"] });
  });

  it("forgets a note that names a database which is gone", async () => {
    noteDeviceCopy("user-a");
    const synced = await syncAnalysisCorpus(input(null, { rows: ["a"] }));
    expect([synced.onDevice, mayHaveDeviceCopy("user-a")]).toEqual([false, false]);
    expect(await factory.databases()).toEqual([]);
  });

  it("stops before dropping a refused copy once its run is cancelled", async () => {
    await keep(["a"]);
    const run = new AbortController();
    const sync = input(null, {}, { signal: run.signal });
    sync.fetchPage.mockImplementation(async () => {
      run.abort();
      return REFUSED;
    });
    await expect(syncAnalysisCorpus(sync)).rejects.toMatchObject({ name: "AbortError" });
    expect(sync.readSnapshot).not.toHaveBeenCalled();
    expect(await copy()).toEqual({ marks: MARKS, ids: ["a"] });
  });

  it("stops before saving a snapshot once its run is cancelled", async () => {
    const run = new AbortController();
    const sync = input(null, { rows: ["s1"] }, { keepOnDevice: true, signal: run.signal });
    const read = sync.readSnapshot.getMockImplementation()!;
    sync.readSnapshot.mockImplementation(async () => {
      run.abort();
      return read();
    });
    await expect(syncAnalysisCorpus(sync)).rejects.toMatchObject({ name: "AbortError" });
    expect(await copy()).toBe("absent");
  });

  it("stops before a failed save's drop once its run is cancelled", async () => {
    const run = new AbortController();
    let release: (() => void) | undefined;
    saveGate.hold = () => new Promise<void>((resolve) => { release = resolve; });
    const unstorable = { ...game("a1"), detail: () => undefined } as unknown as AnalysisApiGame;
    const pending = syncAnalysisCorpus(input(null, { rows: [unstorable] }, { keepOnDevice: true, signal: run.signal }));
    await vi.waitFor(() => expect(release).toBeTypeOf("function"));
    run.abort();
    release?.();
    await expect(pending).rejects.toMatchObject({ name: "AbortError" });
    // A drop would have recorded the account's choice ("kept"); nothing was written.
    expect(await copy()).toBe("absent");
  });

  it("deletes the database when a refused copy can be neither dropped nor replaced and its snapshot fails", async () => {
    await keep(["pre-wipe"]);
    const transaction = FakeIDBDatabase.prototype.transaction;
    vi.spyOn(FakeIDBDatabase.prototype, "transaction").mockImplementation(function (this: IDBDatabase, ...args) {
      if (args[1] === "readwrite") throw new Error("storage full");
      return transaction.apply(this, args as Parameters<typeof transaction>);
    });
    const busy = Object.assign(new Error("busy"), { status: 503 });
    await expect(syncAnalysisCorpus(input(REFUSED, busy))).rejects.toBe(busy);
    vi.restoreAllMocks();
    expect(await untilNoDatabases()).toEqual([]);
  });

  it("shows a fetched snapshot while its first save is still running, with the account already noted", async () => {
    let release: (() => void) | undefined;
    saveGate.hold = () => new Promise<void>((resolve) => { release = resolve; });
    const sync = input(null, { rows: ["s1"] }, { keepOnDevice: true });
    const pending = syncAnalysisCorpus(sync);
    await vi.waitFor(() => expect(release).toBeTypeOf("function"));
    // A sign-out in another tab now finds the copy through the note, before any of its rows exist.
    expect([ids(sync.onSnapshot.mock.calls[0]?.[0]?.items ?? []), mayHaveDeviceCopy("user-a")]).toEqual([["s1"], true]);
    release?.();
    expect((await pending).onDevice).toBe(true);
    expect(await copy()).toEqual({ marks: MARKS, ids: ["s1"] });
  });

  it("creates nothing for a keep that this browser cannot note", async () => {
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new DOMException("full", "QuotaExceededError");
    });
    const open = vi.spyOn(factory, "open");
    const synced = await syncAnalysisCorpus(input(null, { rows: ["s1"] }, { keepOnDevice: true }));
    expect([synced.onDevice, synced.kept, ids(synced.items), open.mock.calls.length]).toEqual([false, false, ["s1"], 0]);
  });

  it.each([
    ["a delta", { items: [{ gameId: "b", removed: true }], nextCursor: null, ...NEXT }],
    ["a refusal", REFUSED],
  ])("writes nothing once the copy is cleared during a changes read that returns %s, and reads again", async (_, answer) => {
    await keep(["a", "b"]);
    noteDeviceCopy("user-a");
    const sync = input(null, { rows: ["after-wipe"] });
    sync.fetchPage.mockImplementation(async () => {
      // Delete history succeeds in another tab while this read is in flight.
      forgetDeviceCopy(leaveDatabase());
      return answer;
    });
    const synced = await syncAnalysisCorpus(sync);
    expect([synced.onDevice, synced.kept, ids(synced.items), mayHaveDeviceCopy("user-a")])
      .toEqual([false, false, ["after-wipe"], false]);
    expect(await copy()).toEqual({ marks: MARKS, ids: ["a", "b"] });
  });

  it("writes nothing once the copy is cleared while a snapshot loads, and reads again", async () => {
    const sync = input(null, { rows: ["s1"] }, { keepOnDevice: true });
    const read = sync.readSnapshot.getMockImplementation()!;
    sync.readSnapshot.mockImplementationOnce(async () => {
      forgetDeviceCopy(leaveDatabase());
      return read();
    });
    const synced = await syncAnalysisCorpus(sync);
    expect([synced.onDevice, synced.kept, sync.readSnapshot.mock.calls.length, sync.onSnapshot.mock.calls.length])
      .toEqual([false, false, 2, 0]);
    expect(await copy()).toBe("absent");
  });

  it("reads again in memory when the copy is cleared during its save", async () => {
    let release: (() => void) | undefined;
    saveGate.hold = () => new Promise<void>((resolve) => { release = resolve; });
    const sync = input(null, { rows: ["s1"] }, { keepOnDevice: true });
    const pending = syncAnalysisCorpus(sync);
    await vi.waitFor(() => expect(release).toBeTypeOf("function"));
    forgetDeviceCopy(leaveDatabase());
    release?.();
    const synced = await pending;
    expect([synced.onDevice, synced.kept, sync.readSnapshot.mock.calls.length]).toEqual([false, false, 2]);
  });

  it("shows nothing of a stored copy that is cleared while the device opens", async () => {
    await keep(["a"]);
    noteDeviceCopy("user-a");
    clearWhileOpening();
    const sync = input(null, { rows: ["fresh"] });
    const synced = await syncAnalysisCorpus(sync);
    vi.restoreAllMocks();
    expect([synced.onDevice, ids(synced.items), sync.onStored.mock.calls.length]).toEqual([false, ["fresh"], 0]);
    expect(await copy()).toEqual({ marks: MARKS, ids: ["a"] });
  });

  it("saves nothing when a first keep is cleared while the device opens", async () => {
    clearWhileOpening();
    const sync = input(null, { rows: ["s1"] }, { keepOnDevice: true });
    const synced = await syncAnalysisCorpus(sync);
    vi.restoreAllMocks();
    expect([synced.onDevice, synced.kept, sync.onSnapshot.mock.calls.length]).toEqual([false, false, 0]);
    expect(await copy()).toBe("absent");
  });

  it("clears another account's copy before this account starts keeping one", async () => {
    await keep(["b-only"], MARKS, "user-b");
    noteDeviceCopy("user-b");
    const busy = Object.assign(new Error("busy"), { status: 503 });
    await expect(syncAnalysisCorpus(input(null, busy, { keepOnDevice: true }))).rejects.toBe(busy);
    // The snapshot failed, yet none of user-b's rows sit under the note that now names user-a.
    expect([mayHaveDeviceCopy("user-a"), await copy("user-b")]).toEqual([true, "absent"]);
  });

  it("keeps nothing here while the note cannot be read, and removes a copy kept before", async () => {
    await keep(["a"]);
    for (const method of ["getItem", "setItem"] as const) {
      vi.spyOn(Storage.prototype, method).mockImplementation(() => {
        throw new DOMException("denied", "SecurityError");
      });
    }
    const sync = input(null, { rows: ["s1"] }, { keepOnDevice: true });
    const synced = await syncAnalysisCorpus(sync);
    vi.restoreAllMocks();
    expect([synced.onDevice, synced.kept, ids(synced.items), sync.onStored.mock.calls.length])
      .toEqual([false, false, ["s1"], 0]);
    expect(await untilNoDatabases()).toEqual([]);
  });

  it("never lets a failed read replace another account's copy unless this account asked to keep one", async () => {
    await keep(["b-only"], MARKS, "user-b");
    const plain = await syncAnalysisCorpus(input(null, { rows: ["a1"] }));
    expect([plain.onDevice, plain.kept]).toEqual([false, false]);
    expect(await copy("user-b")).toEqual({ marks: MARKS, ids: ["b-only"] });

    // The copy's next read fails; opening (and creating) the database still works.
    const transaction = FakeIDBDatabase.prototype.transaction;
    const failRead = () => {
      let failed = false;
      vi.spyOn(FakeIDBDatabase.prototype, "transaction").mockImplementation(function (this: IDBDatabase, ...args) {
        if (args[1] === "readonly" && !failed) {
          failed = true;
          throw new Error("read failed");
        }
        return transaction.apply(this, args as Parameters<typeof transaction>);
      });
    };
    failRead();
    const synced = await syncAnalysisCorpus(input(null, { rows: ["a1"] }));
    expect([synced.onDevice, ids(synced.items)]).toEqual([false, ["a1"]]);
    expect(await copy("user-b")).toEqual({ marks: MARKS, ids: ["b-only"] });

    failRead();
    const kept = await syncAnalysisCorpus(input(null, { rows: ["a1"] }, { keepOnDevice: true }));
    expect(kept.onDevice).toBe(true);
    expect([await copy("user-b"), await copy()]).toEqual(["absent", { marks: MARKS, ids: ["a1"] }]);
  });

  it("still shows its merged corpus when another tab moved the stored copy first", async () => {
    await keep(["a", "b"]);
    const other = { ...MARKS, watermark: "2026-10-31T10:30:00.000Z" };
    const sync = input(null);
    sync.fetchPage.mockImplementation(async () => {
      // Another tab commits its own copy while this one is reading changes.
      await keep(["other-tab"], other);
      return { items: [{ gameId: "b", removed: true }], nextCursor: null, ...NEXT };
    });
    const synced = await syncAnalysisCorpus(sync);
    expect([synced.onDevice, synced.marks, ids(synced.items)]).toEqual([true, NEXT, ["a"]]);
    expect(await copy()).toEqual({ marks: other, ids: ["other-tab"] });
  });
});
