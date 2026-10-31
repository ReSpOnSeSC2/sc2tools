import { IDBFactory } from "fake-indexeddb";
import { describe, expect, it, vi } from "vitest";
import { idbTransactionOn } from "@/lib/instant/idb";
import type { CorpusMarks } from "../changes";
import {
  DEVICE_CORPUS_DB_NAME,
  mergeDeviceDelta,
  openDeviceCorpus,
  readDeviceCorpus,
  resetDeviceCorpus,
  saveDeviceSnapshot,
} from "../deviceStore";

const EPOCH = "1.0123456789abcdef";
const MARKS: CorpusMarks = { corpusVersion: 2, watermark: "2026-10-31T10:00:00.000Z", corpusEpoch: EPOCH };
const NEXT: CorpusMarks = { ...MARKS, watermark: "2026-10-31T11:00:00.000Z" };
type Game = ReturnType<typeof game>;

function game(gameId: string) {
  return { gameId, date: "2026-10-31T09:00:00.000Z", result: "Victory" };
}

async function stored(factory: IDBFactory) {
  const db = await openDeviceCorpus(factory, { create: true });
  if (!db) throw new Error("expected a database");
  return db;
}

async function view(db: IDBDatabase, accountKey = "user-a", maxRows = 10) {
  const copy = await readDeviceCorpus<Game>(db, accountKey, maxRows);
  return copy.kind === "stored"
    ? { marks: copy.marks, rows: copy.rows.map((row) => `${row.gameId}:${row.result}`).sort() }
    : copy.kind;
}

describe("openDeviceCorpus", () => {
  it("probes without creating anything, and has nothing to open without IndexedDB", async () => {
    const factory = new IDBFactory();
    await expect(openDeviceCorpus(factory, { create: false })).resolves.toBeNull();
    // A probe that had created the database would let a second probe open it.
    await expect(openDeviceCorpus(factory, { create: false })).resolves.toBeNull();
    expect(await factory.databases()).toEqual([]);
    await expect(openDeviceCorpus(undefined, { create: true })).resolves.toBeNull();

    (await stored(factory)).close();
    const probed = await openDeviceCorpus(factory, { create: false });
    expect([...(probed?.objectStoreNames ?? [])].sort()).toEqual(["accounts", "games"]);
    probed?.close();
    expect((await factory.databases()).map((db) => db.name)).toEqual([DEVICE_CORPUS_DB_NAME]);
  });

  it("gives up on an open that hangs past the deadline, and closes the connection if it arrives late", async () => {
    const request = {} as IDBOpenDBRequest & { result: unknown };
    const late = { close: vi.fn(), onversionchange: null };
    const factory = { open: () => request } as unknown as IDBFactory;
    await expect(openDeviceCorpus(factory, { create: false, deadlineMs: 10 })).resolves.toBeNull();
    Object.defineProperty(request, "result", { value: late });
    request.onsuccess?.call(request, new Event("success"));
    expect(late.close).toHaveBeenCalledTimes(1);
  });
});

describe("device corpus storage", () => {
  it("round-trips one account's snapshot and marks, and holds one account at a time", async () => {
    const db = await stored(new IDBFactory());
    expect(await view(db)).toBe("absent");

    await saveDeviceSnapshot(db, "user-a", [game("a1"), game("a2"), game("a1")], MARKS, 10);
    expect(await view(db)).toEqual({ marks: MARKS, rows: ["a1:Victory", "a2:Victory"] });

    await saveDeviceSnapshot(db, "user-b", [game("b1")], NEXT, 10);
    expect(await view(db)).toBe("absent");
    expect(await view(db, "user-b")).toEqual({ marks: NEXT, rows: ["b1:Victory"] });
    await expect(saveDeviceSnapshot(db, "user-b", [game("x"), game("y")], MARKS, 1)).rejects.toThrow();
    expect(await view(db, "user-b")).toEqual({ marks: NEXT, rows: ["b1:Victory"] });
    db.close();
  });

  it("drops a copy but keeps the account's choice when reset", async () => {
    const db = await stored(new IDBFactory());
    await saveDeviceSnapshot(db, "user-b", [game("b1")], MARKS, 10);
    await resetDeviceCorpus(db, "user-a");
    expect([await view(db), await view(db, "user-b")]).toEqual(["kept", "absent"]);
    await saveDeviceSnapshot(db, "user-a", [game("a1")], MARKS, 10);
    expect(await view(db)).toEqual({ marks: MARKS, rows: ["a1:Victory"] });
    db.close();
  });

  it("merges a delta's rows in order and moves its marks with them", async () => {
    const db = await stored(new IDBFactory());
    await saveDeviceSnapshot(db, "user-a", [game("keep"), game("gone"), game("edit"), game("back")], MARKS, 10);
    const merged = await mergeDeviceDelta(db, "user-a", MARKS, [
      { gameId: "gone", removed: true },
      { ...game("edit"), result: "Defeat" },
      game("new"),
      { ...game("new"), result: "Defeat" },
      { gameId: "new", removed: true },
      { gameId: "back", removed: true },
      { ...game("back"), result: "Defeat" },
    ], NEXT, 10);
    expect(merged).toBe(true);
    expect(await view(db)).toEqual({ marks: NEXT, rows: ["back:Defeat", "edit:Defeat", "keep:Victory"] });
    db.close();
  });

  it("lets exactly one of two merges from the same marks write", async () => {
    const db = await stored(new IDBFactory());
    await saveDeviceSnapshot(db, "user-a", [game("a1")], MARKS, 10);
    const other = { ...MARKS, watermark: "2026-10-31T10:30:00.000Z" };
    const results = await Promise.all([
      mergeDeviceDelta(db, "user-a", MARKS, [game("first")], NEXT, 10),
      mergeDeviceDelta(db, "user-a", MARKS, [game("second")], other, 10),
    ]);
    expect(results.filter(Boolean)).toHaveLength(1);
    const winner = results[0] ? { marks: NEXT, rows: ["a1:Victory", "first:Victory"] } : { marks: other, rows: ["a1:Victory", "second:Victory"] };
    expect(await view(db)).toEqual(winner);
    db.close();
  });

  it("writes nothing when another tab moved the copy first or the merge would pass the limit", async () => {
    const db = await stored(new IDBFactory());
    await saveDeviceSnapshot(db, "user-a", [game("a1"), game("a2")], MARKS, 3);
    const removal = [{ gameId: "a1", removed: true as const }];
    for (const stale of [{ ...MARKS, watermark: "2026-10-31T09:00:00.000Z" }, { ...MARKS, corpusVersion: 3 }, { ...MARKS, corpusEpoch: "2.0" }]) {
      await expect(mergeDeviceDelta(db, "user-a", stale, removal, NEXT, 3)).resolves.toBe(false);
    }
    await expect(mergeDeviceDelta(db, "user-a", MARKS, [...removal, game("b1"), game("b2")], NEXT, 2)).resolves.toBe(false);
    await expect(mergeDeviceDelta(db, "user-b", MARKS, [game("b1")], NEXT, 3)).resolves.toBe(false);
    expect(await view(db, "user-a", 3)).toEqual({ marks: MARKS, rows: ["a1:Victory", "a2:Victory"] });
    await resetDeviceCorpus(db, "user-c");
    await expect(mergeDeviceDelta(db, "user-c", MARKS, [game("c1")], NEXT, 3)).resolves.toBe(false);
    expect(await view(db, "user-c")).toBe("kept");
    db.close();
  });

  it("reads a copy that does not check out as unreadable", async () => {
    const db = await stored(new IDBFactory());
    await saveDeviceSnapshot(db, "user-a", [game("a1"), game("a2")], MARKS, 10);
    expect(await view(db, "user-a", 1)).toBe("unreadable");
    const edit = (work: (tx: IDBTransaction) => void) => idbTransactionOn(db, ["accounts", "games"], "readwrite", work);
    await edit((tx) => { tx.objectStore("games").delete(["user-a", "a2"]); });
    expect(await view(db)).toBe("unreadable");
    await edit((tx) => { tx.objectStore("games").put({ accountKey: "user-a", gameId: "a2", row: { gameId: "other" } }); });
    expect(await view(db)).toBe("unreadable");
    await edit((tx) => { tx.objectStore("games").put({ accountKey: "user-a", gameId: "a2", row: game("a2") }); });
    expect(await view(db)).toEqual({ marks: MARKS, rows: ["a1:Victory", "a2:Victory"] });
    for (const record of [{ marks: MARKS, count: 2, schema: 99 }, { marks: null, count: 2, schema: 1 }, { marks: { ...MARKS, corpusEpoch: "" }, count: 2, schema: 1 }]) {
      await edit((tx) => { tx.objectStore("accounts").put({ accountKey: "user-a", savedAt: "", ...record }); });
      expect(await view(db)).toBe("unreadable");
    }
    db.close();
  });
});
