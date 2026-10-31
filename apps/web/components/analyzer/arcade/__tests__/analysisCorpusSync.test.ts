import { IDBDatabase as FakeIDBDatabase, IDBFactory } from "fake-indexeddb";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { idbTransactionOn } from "@/lib/instant/idb";
import { deviceClearMark, forgetDeviceCopy } from "@/lib/analysisCorpus/deviceClear";
import { DEVICE_CLEAR_KEY, DEVICE_DELETE_OWED_KEY, DEVICE_NOTE_KEY } from "@/lib/analysisCorpus/deviceKeys";
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

// Lets a test hold a device save (before it runs), or a merge or a drop (after it commits), while it checks what
// already happened; `writes` counts the device writes the sync asked for.
const saveGate = vi.hoisted(() => ({
  hold: null as null | (() => Promise<void>),
  afterMerge: null as null | (() => Promise<void>),
  afterDrop: null as null | (() => Promise<void>),
  writes: 0,
}));

vi.mock("@/lib/analysisCorpus/deviceStore", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/analysisCorpus/deviceStore")>();
  return {
    ...actual,
    saveDeviceSnapshot: async (...args: Parameters<typeof actual.saveDeviceSnapshot>) => {
      await saveGate.hold?.();
      saveGate.writes += 1;
      return actual.saveDeviceSnapshot(...args);
    },
    mergeDeviceDelta: async (...args: Parameters<typeof actual.mergeDeviceDelta>) => {
      saveGate.writes += 1;
      const merged = await actual.mergeDeviceDelta(...args);
      await saveGate.afterMerge?.();
      return merged;
    },
    resetDeviceCorpus: async (...args: Parameters<typeof actual.resetDeviceCorpus>) => {
      saveGate.writes += 1;
      await actual.resetDeviceCorpus(...args);
      await saveGate.afterDrop?.();
    },
  };
});

beforeEach(() => {
  factory = new IDBFactory();
  vi.stubGlobal("indexedDB", factory);
  window.localStorage.clear();
  Object.assign(saveGate, { hold: null, afterMerge: null, afterDrop: null, writes: 0 });
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

/** A copy as a keep leaves it: the account's rows, under the note naming it. */
async function keep(rows: Array<string | AnalysisApiGame>, marks = MARKS, accountKey = "user-a") {
  const hold = saveGate.hold;
  saveGate.hold = null;
  const db = await openDeviceCorpus(factory, { create: true });
  await saveDeviceSnapshot(db!, accountKey, rows.map((row) => (typeof row === "string" ? game(row) : row)), marks, 100);
  db!.close();
  saveGate.hold = hold;
  saveGate.writes = 0;
  noteDeviceCopy(accountKey);
}

/** A connection that ignores versionchange, as a frozen tab's would, so deletes wait until it is released. */
async function blockDeletes() {
  const db = await openDeviceCorpus(factory, { create: false });
  db!.onversionchange = null;
  return () => db!.close();
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

/** Another tab acts (clears the copy, or keeps its own) while this sync opens the device. */
function whileOpening(act: () => void) {
  const open = factory.open.bind(factory);
  return vi.spyOn(factory, "open").mockImplementationOnce((...args: Parameters<IDBFactory["open"]>) => {
    act();
    return open(...args);
  });
}

/** Another tab acts right after this sync's open is queued, so anything it queues comes after that open. */
function afterOpening(act: () => void) {
  const open = factory.open.bind(factory);
  return vi.spyOn(factory, "open").mockImplementationOnce((...args: Parameters<IDBFactory["open"]>) => {
    const request = open(...args);
    act();
    return request;
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

  it("clears in full when the database a note names is gone", async () => {
    noteDeviceCopy("user-a");
    const mark = deviceClearMark();
    const synced = await syncAnalysisCorpus(input(null, { rows: ["a"] }));
    // The mark moves, so a keep another tab had started under that note stops instead of saving under none.
    expect([synced.onDevice, mayHaveDeviceCopy("user-a"), deviceClearMark() === mark]).toEqual([false, false, false]);
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
    // Only the choice the creating upgrade recorded; no rows.
    expect(await copy()).toBe("kept");
  });

  it("stops before a failed save's drop once its run is cancelled", async () => {
    const run = new AbortController();
    let release: (() => void) | undefined;
    let drops = 0;
    saveGate.hold = () => new Promise<void>((resolve) => { release = resolve; });
    // Only drops after the save began count; a keep with no copy of its own drops once before its snapshot.
    saveGate.afterDrop = async () => { if (release) drops += 1; };
    const unstorable = { ...game("a1"), detail: () => undefined } as unknown as AnalysisApiGame;
    const pending = syncAnalysisCorpus(input(null, { rows: [unstorable] }, { keepOnDevice: true, signal: run.signal }));
    await vi.waitFor(() => expect(release).toBeTypeOf("function"));
    run.abort();
    release?.();
    await expect(pending).rejects.toMatchObject({ name: "AbortError" });
    expect([drops, await copy()]).toEqual([0, "kept"]);
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
    const sync = input(null, { rows: ["after-wipe"] });
    sync.fetchPage.mockImplementation(async () => {
      // Delete history succeeds in another tab while this read is in flight.
      forgetDeviceCopy(leaveDatabase());
      return answer;
    });
    const synced = await syncAnalysisCorpus(sync);
    expect([synced.onDevice, synced.kept, ids(synced.items), mayHaveDeviceCopy("user-a"), saveGate.writes])
      .toEqual([false, false, ["after-wipe"], false, 0]);
    expect(await untilNoDatabases()).toEqual([]);
  });

  it("writes nothing once the copy is cleared while a snapshot loads, and reads again", async () => {
    const sync = input(null, { rows: ["s1"] }, { keepOnDevice: true });
    const read = sync.readSnapshot.getMockImplementation()!;
    sync.readSnapshot.mockImplementationOnce(async () => {
      forgetDeviceCopy(leaveDatabase());
      saveGate.writes = 0;
      return read();
    });
    const synced = await syncAnalysisCorpus(sync);
    expect([synced.onDevice, synced.kept, sync.readSnapshot.mock.calls.length, sync.onSnapshot.mock.calls.length, saveGate.writes])
      .toEqual([false, false, 2, 0, 0]);
    expect(await untilNoDatabases()).toEqual([]);
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
    whileOpening(() => forgetDeviceCopy(leaveDatabase()));
    const sync = input(null, { rows: ["fresh"] });
    const synced = await syncAnalysisCorpus(sync);
    expect([synced.onDevice, ids(synced.items), sync.onStored.mock.calls.length, saveGate.writes]).toEqual([false, ["fresh"], 0, 0]);
    expect(await untilNoDatabases()).toEqual([]);
  });

  it("saves nothing when a first keep is cleared while the device opens", async () => {
    whileOpening(() => forgetDeviceCopy(leaveDatabase()));
    const sync = input(null, { rows: ["s1"] }, { keepOnDevice: true });
    const synced = await syncAnalysisCorpus(sync);
    expect([synced.onDevice, synced.kept, sync.onSnapshot.mock.calls.length, saveGate.writes]).toEqual([false, false, 0, 0]);
    // Not even the account's record that its open wrote is left once the note is gone.
    expect(await untilNoDatabases()).toEqual([]);
  });

  it("leaves no record behind when a keep that a clear stopped is also cancelled", async () => {
    const run = new AbortController();
    whileOpening(() => {
      // A sign-out in another tab clears the copy, and this tab's run is cancelled with it.
      forgetDeviceCopy(leaveDatabase());
      run.abort();
    });
    const sync = input(null, { rows: ["s1"] }, { keepOnDevice: true, signal: run.signal });
    await expect(syncAnalysisCorpus(sync)).rejects.toMatchObject({ name: "AbortError" });
    expect(await untilNoDatabases()).toEqual([]);
  });

  it("writes nothing once another account's keep takes the note, and reads again in memory", async () => {
    // user-b starts keeping in another tab; its clear came before this sync read the mark, so only the note moves.
    whileOpening(() => noteDeviceCopy("user-b"));
    const sync = input(null, { rows: ["s1"] }, { keepOnDevice: true });
    const synced = await syncAnalysisCorpus(sync);
    expect([synced.onDevice, synced.kept, sync.onSnapshot.mock.calls.length, mayHaveDeviceCopy("user-b")])
      .toEqual([false, false, 0, true]);
    // None of user-a's rows sit under user-b's note: only the choice its own open recorded, which user-b's save replaces.
    expect(await copy()).toBe("kept");
  });

  it("clears a copy that its note does not explain", async () => {
    await keep(["b-only"], MARKS, "user-b");
    noteDeviceCopy("user-a");
    const synced = await syncAnalysisCorpus(input(null, { rows: ["a1"] }));
    expect([synced.onDevice, mayHaveDeviceCopy("user-a")]).toEqual([false, false]);
    expect(await untilNoDatabases()).toEqual([]);
  });

  it.each([["another account", "user-b"], ["nobody", null]])("clears a copy noted for %s before this account starts keeping one", async (_, noted) => {
    await keep(["b-only"], MARKS, "user-b");
    if (noted) noteDeviceCopy(noted);
    else window.localStorage.removeItem(DEVICE_NOTE_KEY);
    const busy = Object.assign(new Error("busy"), { status: 503 });
    await expect(syncAnalysisCorpus(input(null, busy, { keepOnDevice: true }))).rejects.toBe(busy);
    // The snapshot failed, yet none of user-b's rows sit under the note that now names user-a.
    expect([mayHaveDeviceCopy("user-a"), await copy("user-b")]).toEqual([true, "absent"]);
  });

  it("removes a copy noted for nobody even when its keep is cancelled before dropping anything", async () => {
    await keep(["b-only"], MARKS, "user-b");
    window.localStorage.removeItem(DEVICE_NOTE_KEY);
    const run = new AbortController();
    whileOpening(() => run.abort());
    await expect(syncAnalysisCorpus(input(null, { rows: ["a1"] }, { keepOnDevice: true, signal: run.signal })))
      .rejects.toMatchObject({ name: "AbortError" });
    expect(await copy("user-b")).toBe("absent");
  });

  it("lets a probe in another tab store beside a first keep, so the keep's choice and its note survive", async () => {
    let release: (() => void) | undefined;
    const keeping = input(null, { rows: ["s1"] }, { keepOnDevice: true });
    const read = keeping.readSnapshot.getMockImplementation()!;
    keeping.readSnapshot.mockImplementationOnce(async () => {
      await new Promise<void>((resolve) => { release = resolve; });
      return read();
    });
    const pending = syncAnalysisCorpus(keeping);
    await vi.waitFor(() => expect(release).toBeTypeOf("function"));
    // Another tab of the same account loads while the keep still reads its snapshot: the copy holds the choice only.
    const probe = await syncAnalysisCorpus(input(null, { rows: ["s1"] }));
    release?.();
    const kept = await pending;
    expect([probe.onDevice, kept.onDevice, kept.kept, mayHaveDeviceCopy("user-a")]).toEqual([true, true, true, true]);
    expect(await copy()).toEqual({ marks: MARKS, ids: ["s1"] });
  });

  it("leaves the note alone once its run is cancelled", async () => {
    const db = await openDeviceCorpus(factory, { create: true });
    db!.close();
    noteDeviceCopy("user-a");
    const run = new AbortController();
    const transaction = FakeIDBDatabase.prototype.transaction;
    vi.spyOn(FakeIDBDatabase.prototype, "transaction").mockImplementationOnce(function (this: IDBDatabase, ...args) {
      // A keep click in this tab cancels the probe while it reads; that keep may write the same note.
      run.abort();
      return transaction.apply(this, args as Parameters<typeof transaction>);
    });
    await syncAnalysisCorpus(input(null, { rows: ["s1"] }, { signal: run.signal }));
    expect([mayHaveDeviceCopy("user-a"), (await factory.databases()).length]).toEqual([true, 1]);
  });

  it("leaves the note to a newer keep when its own run is no longer current", async () => {
    const db = await openDeviceCorpus(factory, { create: true });
    db!.close();
    noteDeviceCopy("user-a");
    const transaction = FakeIDBDatabase.prototype.transaction;
    vi.spyOn(FakeIDBDatabase.prototype, "transaction").mockImplementationOnce(function (this: IDBDatabase, ...args) {
      // While this probe reads, another tab clears the copy and a new keep there notes the account again.
      forgetDeviceCopy(leaveDatabase());
      noteDeviceCopy("user-a");
      return transaction.apply(this, args as Parameters<typeof transaction>);
    });
    const synced = await syncAnalysisCorpus(input(null, { rows: ["s1"] }));
    expect([synced.onDevice, mayHaveDeviceCopy("user-a"), (await factory.databases()).length]).toEqual([false, true, 1]);
  });

  it("takes back the note of a first keep that cannot open the device, but not a note it found", async () => {
    let markAtOpen: string | null = null;
    const refuse = () => vi.spyOn(factory, "open").mockImplementation(() => {
      markAtOpen = deviceClearMark();
      throw new DOMException("denied", "SecurityError");
    });
    refuse();
    const first = await syncAnalysisCorpus(input(null, { rows: ["s1"] }, { keepOnDevice: true }));
    // Taken back in a full clear: the mark moves, so a keep in another tab under the same note stops too.
    expect([first.onDevice, first.kept, ids(first.items), mayHaveDeviceCopy("user-a"), deviceClearMark() === markAtOpen])
      .toEqual([false, false, ["s1"], false, false]);
    vi.restoreAllMocks();

    noteDeviceCopy("user-a");
    refuse();
    const again = await syncAnalysisCorpus(input(null, { rows: ["s1"] }, { keepOnDevice: true }));
    expect([again.onDevice, mayHaveDeviceCopy("user-a")]).toEqual([false, true]);
  });

  it("reads again in memory when the copy is cleared while a delta merges", async () => {
    await keep(["a", "b"]);
    let release: (() => void) | undefined;
    saveGate.afterMerge = () => new Promise<void>((resolve) => { release = resolve; });
    const sync = input({ items: [game("c")], nextCursor: null, ...NEXT }, { rows: ["after-wipe"] });
    const pending = syncAnalysisCorpus(sync);
    await vi.waitFor(() => expect(release).toBeTypeOf("function"));
    forgetDeviceCopy(leaveDatabase());
    release?.();
    const synced = await pending;
    expect([synced.onDevice, ids(synced.items), sync.readSnapshot.mock.calls.length]).toEqual([false, ["after-wipe"], 1]);
  });

  it("reads again in memory when the copy is cleared while a failed save's drop runs", async () => {
    let release: (() => void) | undefined;
    let drops = 0;
    // The second drop is the failed save's; the first is the keep's own before its snapshot.
    saveGate.afterDrop = () => (++drops === 2 ? new Promise<void>((resolve) => { release = resolve; }) : Promise.resolve());
    const unstorable = { ...game("a1"), detail: () => undefined } as unknown as AnalysisApiGame;
    const sync = input(null, { rows: [unstorable] }, { keepOnDevice: true });
    const pending = syncAnalysisCorpus(sync);
    await vi.waitFor(() => expect(release).toBeTypeOf("function"));
    forgetDeviceCopy(leaveDatabase());
    release?.();
    const synced = await pending;
    expect([synced.onDevice, synced.kept, sync.readSnapshot.mock.calls.length]).toEqual([false, false, 2]);
  });

  it("reads again in memory when the copy is cleared while a failed save's drop fails too", async () => {
    let drops = 0;
    saveGate.afterDrop = async () => {
      if (++drops < 2) return;
      forgetDeviceCopy(leaveDatabase());
      throw new Error("storage full");
    };
    const sync = input(null, { rows: [{ ...game("a1"), detail: () => undefined } as unknown as AnalysisApiGame] }, { keepOnDevice: true });
    const synced = await syncAnalysisCorpus(sync);
    expect([synced.onDevice, synced.kept, sync.readSnapshot.mock.calls.length]).toEqual([false, false, 2]);
  });

  it("keeps using this account's own copy when it asks to keep one again", async () => {
    await keep(["a"]);
    const sync = input({ items: [], nextCursor: null, ...NEXT }, {}, { keepOnDevice: true });
    const synced = await syncAnalysisCorpus(sync);
    expect([sync.onStored.mock.calls.length, sync.readSnapshot.mock.calls.length, synced.onDevice]).toEqual([1, 0, true]);
  });

  it("leaves a newer keep alone when a stale copy's sync finds the copy is no longer its own", async () => {
    await keep(["a"]);
    // The refused copy cannot be dropped (storage full), so it is stale while the snapshot is read.
    saveGate.afterDrop = async () => { throw new Error("storage full"); };
    const sync = input(REFUSED, { rows: ["fresh"] });
    const read = sync.readSnapshot.getMockImplementation()!;
    sync.readSnapshot.mockImplementationOnce(async () => {
      // Meanwhile Delete history runs in another tab, and the account keeps its history there again.
      forgetDeviceCopy(leaveDatabase());
      saveGate.afterDrop = null;
      await keep(["kept-again"]);
      return read();
    });
    await syncAnalysisCorpus(sync);
    expect([mayHaveDeviceCopy("user-a"), await copy()]).toEqual([true, { marks: MARKS, ids: ["kept-again"] }]);
  });

  it("settles a delete owed from before it began once its own open succeeds", async () => {
    await keep(["a"]);
    // A clear whose page closed before its delete reported back; the delete finished all the same.
    window.localStorage.setItem(DEVICE_CLEAR_KEY, "earlier-clear");
    window.localStorage.setItem(DEVICE_DELETE_OWED_KEY, "earlier-clear");
    await syncAnalysisCorpus(input({ items: [], nextCursor: null, ...NEXT }));
    expect(window.localStorage.getItem(DEVICE_DELETE_OWED_KEY)).toBeNull();
  });

  it("never clears its own copy over a read that fails", async () => {
    await keep(["a"]);
    vi.spyOn(FakeIDBDatabase.prototype, "transaction").mockImplementationOnce(() => {
      throw new Error("read failed");
    });
    const synced = await syncAnalysisCorpus(input(null, { rows: ["a1"] }));
    expect([synced.onDevice, mayHaveDeviceCopy("user-a")]).toEqual([false, true]);
    expect(await copy()).toEqual({ marks: MARKS, ids: ["a"] });
  });

  it("takes back a first keep whose open lands after the deadline, once it finally does", async () => {
    await keep(["b-only"], MARKS, "user-b");
    const release = await blockDeletes();
    try {
      const synced = await syncAnalysisCorpus(input(null, { rows: ["s1"] }, { keepOnDevice: true }));
      expect([synced.onDevice, synced.kept, mayHaveDeviceCopy("user-a")]).toEqual([false, false, false]);
    } finally {
      release();
    }
    expect(await untilNoDatabases()).toEqual([]);
  }, 10_000);

  it("keeps the note and the account's record together when a keep is cancelled while its open waits", async () => {
    await keep(["b-only"], MARKS, "user-b");
    const release = await blockDeletes();
    try {
      const run = new AbortController();
      const pending = syncAnalysisCorpus(input(null, { rows: ["s1"] }, { keepOnDevice: true, signal: run.signal }));
      run.abort();
      await pending;
      // The open that missed its deadline settles nothing: the keep's own clear still owes its blocked delete.
      expect(window.localStorage.getItem(DEVICE_DELETE_OWED_KEY)).toBe(deviceClearMark());
    } finally {
      release();
    }
    await vi.waitFor(() => expect(window.localStorage.getItem(DEVICE_DELETE_OWED_KEY)).toBeNull());
    expect([mayHaveDeviceCopy("user-a"), await copy(), await copy("user-b")]).toEqual([true, "kept", "absent"]);
  }, 10_000);

  it("drops another account's rows itself before a keep's snapshot when the clear's delete never ran", async () => {
    await keep(["b-only"], MARKS, "user-b");
    // The first-keep clear's delete is lost (a stub request that never finishes), so the keep opens the old database.
    vi.spyOn(factory, "deleteDatabase").mockImplementationOnce(() => ({}) as IDBOpenDBRequest);
    const busy = Object.assign(new Error("busy"), { status: 503 });
    await expect(syncAnalysisCorpus(input(null, busy, { keepOnDevice: true }))).rejects.toBe(busy);
    expect([mayHaveDeviceCopy("user-a"), await copy("user-b"), await copy()]).toEqual([true, "absent", "kept"]);
  });

  it("still deletes a copy it could neither replace nor drop when its run is cancelled", async () => {
    await keep(["a"]);
    saveGate.afterDrop = async () => { throw new Error("storage full"); };
    const run = new AbortController();
    const sync = input(REFUSED, { rows: ["fresh"] }, { signal: run.signal });
    const read = sync.readSnapshot.getMockImplementation()!;
    sync.readSnapshot.mockImplementationOnce(async () => {
      run.abort();
      return read();
    });
    await expect(syncAnalysisCorpus(sync)).rejects.toMatchObject({ name: "AbortError" });
    expect(mayHaveDeviceCopy("user-a")).toBe(false);
    expect(await untilNoDatabases()).toEqual([]);
  });

  it("settles only a delete owed from before its own open", async () => {
    await keep(["a"]);
    let clearMark: string | null = null;
    afterOpening(() => {
      // A clear in another tab, whose delete is queued behind this open.
      forgetDeviceCopy(factory);
      clearMark = deviceClearMark();
    });
    let owedAtRead: string | null = "never read";
    const transaction = FakeIDBDatabase.prototype.transaction;
    vi.spyOn(FakeIDBDatabase.prototype, "transaction").mockImplementationOnce(function (this: IDBDatabase, ...args) {
      owedAtRead = window.localStorage.getItem(DEVICE_DELETE_OWED_KEY);
      return transaction.apply(this, args as Parameters<typeof transaction>);
    });
    await syncAnalysisCorpus(input(null, { rows: ["fresh"] }));
    expect([clearMark === null, owedAtRead === clearMark]).toEqual([false, true]);
  });

  it("keeps nothing here while the note cannot be read, and removes a copy kept before", async () => {
    await keep(["a"]);
    for (const method of ["getItem", "setItem"] as const) {
      vi.spyOn(Storage.prototype, method).mockImplementation(() => {
        throw new DOMException("denied", "SecurityError");
      });
    }
    // The provider probes every account while the note cannot be read; this account's own copy is not shown either.
    const sync = input(null, { rows: ["s1"] });
    const synced = await syncAnalysisCorpus(sync);
    expect([synced.onDevice, synced.kept, ids(synced.items), sync.onStored.mock.calls.length])
      .toEqual([false, false, ["s1"], 0]);
    vi.restoreAllMocks();
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
