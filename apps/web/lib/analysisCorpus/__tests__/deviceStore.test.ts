import { IDBFactory } from "fake-indexeddb";
import { describe, expect, it } from "vitest";
import { idbTransactionOn } from "@/lib/instant/idb";
import type { CorpusMarks } from "../changes";
import {
  DEVICE_CORPUS_DB_NAME,
  clearDeviceCorpus,
  mergeDeviceDelta,
  openDeviceCorpus,
  readDeviceCorpus,
  saveDeviceSnapshot,
} from "../deviceStore";

const MARKS: CorpusMarks = { corpusVersion: 2, watermark: "2026-10-31T10:00:00.000Z" };
const NEXT: CorpusMarks = { corpusVersion: 2, watermark: "2026-10-31T11:00:00.000Z" };

function game(gameId: string) {
  return { gameId, date: "2026-10-31T09:00:00.000Z", result: "Victory" };
}

async function stored(factory: IDBFactory) {
  const db = await openDeviceCorpus(factory, { create: true });
  if (!db) throw new Error("expected a database");
  return db;
}

function ids(rows: Array<{ gameId: string }>) {
  return rows.map((row) => row.gameId).sort();
}

describe("openDeviceCorpus", () => {
  it("probes without creating anything, and has nothing to open without IndexedDB", async () => {
    const factory = new IDBFactory();
    await expect(openDeviceCorpus(factory, { create: false })).resolves.toBeNull();
    expect(await factory.databases()).toEqual([]);
    await expect(openDeviceCorpus(undefined, { create: true })).resolves.toBeNull();

    (await stored(factory)).close();
    const probed = await openDeviceCorpus(factory, { create: false });
    expect([...(probed?.objectStoreNames ?? [])].sort()).toEqual(["accounts", "games"]);
    probed?.close();
    expect((await factory.databases()).map((db) => db.name)).toEqual([DEVICE_CORPUS_DB_NAME]);
  });
});

describe("device corpus storage", () => {
  it("round-trips one account's snapshot and marks, and holds one account at a time", async () => {
    const db = await stored(new IDBFactory());
    expect(await readDeviceCorpus(db, "user-a", 10)).toEqual({ kind: "absent" });

    await saveDeviceSnapshot(db, "user-a", [game("a1"), game("a2"), game("a1")], MARKS, 10);
    const first = await readDeviceCorpus<ReturnType<typeof game>>(db, "user-a", 10);
    expect(first.kind === "stored" && [first.marks, ids(first.rows)]).toEqual([MARKS, ["a1", "a2"]]);

    await saveDeviceSnapshot(db, "user-b", [game("b1")], NEXT, 10);
    expect(await readDeviceCorpus(db, "user-a", 10)).toEqual({ kind: "absent" });
    const second = await readDeviceCorpus<ReturnType<typeof game>>(db, "user-b", 10);
    expect(second.kind === "stored" && ids(second.rows)).toEqual(["b1"]);
    await expect(saveDeviceSnapshot(db, "user-b", [game("x"), game("y")], MARKS, 1)).rejects.toThrow();

    await clearDeviceCorpus(db);
    expect(await readDeviceCorpus(db, "user-b", 10)).toEqual({ kind: "absent" });
    db.close();
  });

  it("merges a delta's rows and moves its marks together", async () => {
    const db = await stored(new IDBFactory());
    await saveDeviceSnapshot(db, "user-a", [game("keep"), game("gone"), game("edit")], MARKS, 10);
    const merged = await mergeDeviceDelta(db, "user-a", MARKS, [
      { gameId: "gone", removed: true },
      { ...game("edit"), result: "Defeat" },
      game("new"),
    ], NEXT, 10);
    expect(merged).toBe(true);
    const after = await readDeviceCorpus<ReturnType<typeof game>>(db, "user-a", 10);
    expect(after.kind === "stored" && after.marks).toEqual(NEXT);
    expect(after.kind === "stored" && after.rows.map((row) => [row.gameId, row.result]).sort()).toEqual([
      ["edit", "Defeat"], ["keep", "Victory"], ["new", "Victory"],
    ]);
    db.close();
  });

  it("writes nothing when another tab moved the copy first or the merge would pass the limit", async () => {
    const db = await stored(new IDBFactory());
    await saveDeviceSnapshot(db, "user-a", [game("a1"), game("a2")], MARKS, 3);
    const stale = { ...MARKS, watermark: "2026-10-31T09:00:00.000Z" };
    await expect(mergeDeviceDelta(db, "user-a", stale, [{ gameId: "a1", removed: true }], NEXT, 3)).resolves.toBe(false);
    await expect(mergeDeviceDelta(db, "user-a", MARKS, [{ gameId: "a1", removed: true }, game("b1"), game("b2")], NEXT, 2))
      .resolves.toBe(false);
    await expect(mergeDeviceDelta(db, "user-b", MARKS, [game("b1")], NEXT, 3)).resolves.toBe(false);
    const after = await readDeviceCorpus<ReturnType<typeof game>>(db, "user-a", 3);
    expect(after.kind === "stored" && [after.marks, ids(after.rows)]).toEqual([MARKS, ["a1", "a2"]]);
    db.close();
  });

  it("reads a copy that does not check out as unreadable", async () => {
    const db = await stored(new IDBFactory());
    await saveDeviceSnapshot(db, "user-a", [game("a1"), game("a2")], MARKS, 10);
    expect(await readDeviceCorpus(db, "user-a", 1)).toEqual({ kind: "unreadable" });
    await idbTransactionOn(db, "games", "readwrite", (tx) => {
      tx.objectStore("games").delete(["user-a", "a2"]);
    });
    expect(await readDeviceCorpus(db, "user-a", 10)).toEqual({ kind: "unreadable" });
    await idbTransactionOn(db, ["accounts", "games"], "readwrite", (tx) => {
      tx.objectStore("games").put({ accountKey: "user-a", gameId: "a2", row: { gameId: "other" } });
    });
    expect(await readDeviceCorpus(db, "user-a", 10)).toEqual({ kind: "unreadable" });
    await idbTransactionOn(db, "accounts", "readwrite", (tx) => {
      tx.objectStore("accounts").put({ accountKey: "user-a", ...MARKS, count: 2, savedAt: "", schema: 99 });
    });
    expect(await readDeviceCorpus(db, "user-a", 10)).toEqual({ kind: "unreadable" });
    db.close();
  });
});
