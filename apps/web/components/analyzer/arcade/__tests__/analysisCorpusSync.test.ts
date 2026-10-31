import { IDBDatabase as FakeIDBDatabase, IDBFactory } from "fake-indexeddb";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { idbTransactionOn } from "@/lib/instant/idb";
import {
  openDeviceCorpus,
  readDeviceCorpus,
  saveDeviceSnapshot,
} from "@/lib/analysisCorpus/deviceStore";
import {
  syncAnalysisCorpus,
  type CorpusSyncInput,
} from "../hooks/analysisCorpusSync";
import type { AnalysisApiGame, AnalysisGamesPage } from "../hooks/useAnalysisGames";

const EPOCH = "1.0123456789abcdef";
const MARKS = { corpusVersion: 1, watermark: "2026-10-31T10:00:00.000Z", corpusEpoch: EPOCH };
const NEXT = { ...MARKS, watermark: "2026-10-31T11:00:00.000Z" };
let factory: IDBFactory;

beforeEach(() => {
  factory = new IDBFactory();
  vi.stubGlobal("indexedDB", factory);
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

function game(gameId: string): AnalysisApiGame {
  return { gameId, date: "2026-10-31T09:00:00.000Z", result: "Victory" } as AnalysisApiGame;
}

const pageKey = (pageIndex: number, previous: AnalysisGamesPage | null) =>
  pageIndex === 0 ? "/v1/games/analysis-corpus?limit=2"
    : previous?.nextCursor ? `/v1/games/analysis-corpus?cursor=${previous.nextCursor}` : null;

/** A server whose snapshot is `rows` (with `marks`, when given) and whose changes route answers `changes`. */
function input(
  rows: Array<string | AnalysisApiGame>,
  changes: unknown,
  overrides: Partial<Omit<CorpusSyncInput, "fetchPage" | "onStored">> = {},
  marks: unknown = MARKS,
) {
  const fetchPage = vi.fn(async (path: string): Promise<unknown> => {
    if (path.startsWith("/v1/games/analysis-corpus/changes")) {
      if (changes instanceof Error) throw changes;
      return changes;
    }
    const items = rows.map((row) => (typeof row === "string" ? game(row) : row));
    return { items, nextCursor: null, ...(marks as object) };
  });
  const onStored = vi.fn();
  return {
    accountKey: "user-a", keepOnDevice: false, pageKey, maxRows: 100, pageSize: 2, maxPages: 10,
    ...overrides, fetchPage, onStored,
  } satisfies CorpusSyncInput;
}

const requested = (sync: ReturnType<typeof input>) => sync.fetchPage.mock.calls.map(([path]) => path.split("?")[0]);

async function keep(rows: string[], marks = MARKS, accountKey = "user-a") {
  const db = await openDeviceCorpus(factory, { create: true });
  await saveDeviceSnapshot(db!, accountKey, rows.map(game), marks, 100);
  db!.close();
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

describe("syncAnalysisCorpus", () => {
  it("loads in memory only when IndexedDB is unavailable, even when asked to keep a copy", async () => {
    vi.stubGlobal("indexedDB", undefined);
    const synced = await syncAnalysisCorpus(input(["a"], null, { keepOnDevice: true }));
    expect([synced.onDevice, synced.items.map((row) => row.gameId)]).toEqual([false, ["a"]]);
  });

  it("replaces an unreadable copy with a snapshot without showing it", async () => {
    await keep(["a", "b"]);
    const db = await openDeviceCorpus(factory, { create: false });
    await idbTransactionOn(db!, "games", "readwrite", (tx) => { tx.objectStore("games").delete(["user-a", "b"]); });
    db!.close();
    const sync = input(["fresh"], null);
    const synced = await syncAnalysisCorpus(sync);
    expect(sync.onStored).not.toHaveBeenCalled();
    expect(synced.onDevice).toBe(true);
    expect(await copy()).toEqual({ marks: MARKS, ids: ["fresh"] });
  });

  it("takes a snapshot when the merged corpus would pass the row limit", async () => {
    await keep(["a", "b"]);
    const sync = input(["s1", "s2"], { items: [game("c")], nextCursor: null, ...NEXT }, { maxRows: 2 });
    const synced = await syncAnalysisCorpus(sync);
    expect(synced.items.map((row) => row.gameId)).toEqual(["s1", "s2"]);
    expect(requested(sync)).toEqual(["/v1/games/analysis-corpus/changes", "/v1/games/analysis-corpus"]);
    expect(await copy()).toEqual({ marks: MARKS, ids: ["s1", "s2"] });
  });

  it("drops the copy past the corpus ceiling, keeping the account's choice", async () => {
    await keep(["a"]);
    const sync = input(["s1", "s2", "s3"], { snapshotRequired: "corpus_version", corpusVersion: 2, corpusEpoch: EPOCH }, { maxRows: 2 });
    const synced = await syncAnalysisCorpus(sync);
    expect([synced.hitCorpusLimit, synced.onDevice, synced.items.length]).toEqual([true, false, 2]);
    expect(await copy()).toBe("kept");
  });

  it("drops a copy that a snapshot without marks could not replace, so it is not shown again", async () => {
    await keep(["a"]);
    const missing = Object.assign(new Error("Not found"), { status: 404 });
    const synced = await syncAnalysisCorpus(input(["s1"], missing, {}, {}));
    expect([synced.onDevice, synced.marks, synced.items.map((row) => row.gameId)]).toEqual([false, null, ["s1"]]);
    expect(await copy()).toBe("kept");
    const next = input(["s2"], null);
    const after = await syncAnalysisCorpus(next);
    expect(next.onStored).not.toHaveBeenCalled();
    expect([after.onDevice, requested(next)]).toEqual([true, ["/v1/games/analysis-corpus"]]);
    expect(await copy()).toEqual({ marks: MARKS, ids: ["s2"] });
  });

  it("drops the old copy when the snapshot that should replace it cannot be saved", async () => {
    await keep(["pre-wipe"]);
    // A row that cannot be stored makes the replacing save fail, as a full disk would.
    const unstorable = { ...game("post-wipe"), detail: () => undefined } as unknown as AnalysisApiGame;
    const sync = input([unstorable], { snapshotRequired: "corpus_version", corpusVersion: 2, corpusEpoch: EPOCH });
    const synced = await syncAnalysisCorpus(sync);
    expect([synced.onDevice, synced.items.map((row) => row.gameId)]).toEqual([false, ["post-wipe"]]);
    expect(await copy()).toBe("kept");
  });

  it("never lets a failed read replace another account's copy unless this account asked to keep one", async () => {
    await keep(["b-only"], MARKS, "user-b");
    const failRead = () => vi.spyOn(FakeIDBDatabase.prototype, "transaction").mockImplementationOnce(() => {
      throw new Error("read failed");
    });
    failRead();
    const synced = await syncAnalysisCorpus(input(["a1"], null));
    expect([synced.onDevice, synced.items.map((row) => row.gameId)]).toEqual([false, ["a1"]]);
    expect(await copy("user-b")).toEqual({ marks: MARKS, ids: ["b-only"] });

    failRead();
    const kept = await syncAnalysisCorpus(input(["a1"], null, { keepOnDevice: true }));
    expect(kept.onDevice).toBe(true);
    expect([await copy("user-b"), await copy()]).toEqual(["absent", { marks: MARKS, ids: ["a1"] }]);
  });

  it("still shows its merged corpus when another tab moved the stored copy first", async () => {
    await keep(["a", "b"]);
    const other = { ...MARKS, watermark: "2026-10-31T10:30:00.000Z" };
    const sync = input([], null);
    sync.fetchPage.mockImplementation(async () => {
      // Another tab commits its own copy while this one is reading changes.
      await keep(["other-tab"], other);
      return { items: [{ gameId: "b", removed: true }], nextCursor: null, ...NEXT };
    });
    const synced = await syncAnalysisCorpus(sync);
    expect([synced.onDevice, synced.marks, synced.items.map((row) => row.gameId)]).toEqual([true, NEXT, ["a"]]);
    expect(await copy()).toEqual({ marks: other, ids: ["other-tab"] });
  });
});
