import "fake-indexeddb/auto";
import { IDBFactory } from "fake-indexeddb";
import { afterEach, describe, expect, it, vi } from "vitest";
import { INSTANT_DB_NAME, idbPut, openInstantDb } from "../idb";
import { TRY_TTL_MS, createInstantLocalStore } from "../localStore";
import type { DirectoryHandleLike } from "../folderSync";
import type { LedgerEntry } from "../ledger";

const NOW = Date.parse("2026-09-27T12:00:00Z");

function freshStore() {
  const factory = new IDBFactory();
  const open = () => openInstantDb(factory);
  return { store: createInstantLocalStore(open), open };
}

function game(gameId: string, date: string) {
  return { gameId, json: `{"gameId":"${gameId}"}`, date };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("try games", () => {
  it("saves, loads newest first, and counts", async () => {
    const { store } = freshStore();
    await store.saveTryGames([game("a", "2026-09-01T00:00:00Z"), game("b", "2026-09-20T00:00:00Z")], NOW);
    const rows = await store.loadTryGames(NOW);
    expect(rows.map((r) => r.gameId)).toEqual(["b", "a"]);
    expect(rows[0]).toMatchObject({ storedAt: NOW, expiresAt: NOW + TRY_TTL_MS });
    expect(await store.countTryGames(NOW)).toBe(2);
  });

  it("purges games after 7 days, before any read", async () => {
    const { store } = freshStore();
    await store.saveTryGames([game("old", "2026-09-01T00:00:00Z")], NOW);
    await store.saveTryGames([game("new", "2026-09-02T00:00:00Z")], NOW + 3 * 24 * 3600 * 1000);
    const later = NOW + TRY_TTL_MS + 1;
    expect((await store.loadTryGames(later)).map((r) => r.gameId)).toEqual(["new"]);
    expect(await store.countTryGames(later)).toBe(1);
    expect(await store.purgeExpired(NOW + 30 * TRY_TTL_MS)).toBe(1);
    expect(await store.countTryGames(NOW)).toBe(0);
  });

  it("keeps a game exactly until its expiry instant is passed", async () => {
    const { store } = freshStore();
    await store.saveTryGames([game("a", "2026-09-01T00:00:00Z")], NOW);
    expect(await store.countTryGames(NOW + TRY_TTL_MS - 1)).toBe(1);
    expect(await store.countTryGames(NOW + TRY_TTL_MS)).toBe(0);
  });

  it("upserts and refreshes the expiry", async () => {
    const { store } = freshStore();
    await store.saveTryGames([game("a", "2026-09-01T00:00:00Z")], NOW);
    await store.saveTryGames([game("a", "2026-09-01T00:00:00Z")], NOW + 1000);
    const rows = await store.loadTryGames(NOW + 1000);
    expect(rows).toHaveLength(1);
    expect(rows[0].expiresAt).toBe(NOW + 1000 + TRY_TTL_MS);
  });

  it("clears /try data and drops malformed rows", async () => {
    const { store, open } = freshStore();
    await store.saveTryGames([game("a", "2026-09-01T00:00:00Z")], NOW);
    await idbPut(await open(), "tryGames", { gameId: "bad", expiresAt: NOW + TRY_TTL_MS });
    expect((await store.loadTryGames(NOW)).map((r) => r.gameId)).toEqual(["a"]);
    await store.clearTryData();
    expect(await store.loadTryGames(NOW)).toEqual([]);
  });
});

describe("ledger persistence", () => {
  it("saves, loads (validated) and clears entries", async () => {
    const { store, open } = freshStore();
    const entries: LedgerEntry[] = [
      { path: "a", size: 1, lastModified: 2, status: "uploaded", gameId: "g", updatedAt: 3 },
      { path: "b", size: 1, lastModified: 2, status: "failed", errorKind: "timeout", updatedAt: 3 },
    ];
    await store.saveLedgerEntries(entries);
    await idbPut(await open(), "ledger", { path: "junk", status: "weird" });
    await idbPut(await open(), "ledger", {
      path: "c", size: 1, lastModified: 2, status: "failed", errorKind: "future_kind", updatedAt: 3,
    });
    const loaded = await store.loadLedger();
    expect(loaded).toEqual([
      ...entries,
      { path: "c", size: 1, lastModified: 2, status: "failed", updatedAt: 3 },
    ]);
    await store.clearLedger();
    expect(await store.loadLedger()).toEqual([]);
  });
});

describe("folder handle and meta", () => {
  it("round-trips a directory handle", async () => {
    const { store } = freshStore();
    const handle: DirectoryHandleLike = {
      kind: "directory",
      name: "Accounts",
      async *values() {},
    };
    // Mock: real FileSystemDirectoryHandles are serializable platform objects;
    // simulate that by letting this one object through structuredClone intact.
    const realClone = globalThis.structuredClone;
    vi.stubGlobal("structuredClone", (value: unknown) => (value === handle ? handle : realClone(value)));
    await store.saveFolderHandle(handle);
    expect(await store.loadFolderHandle()).toBe(handle);
    await store.clearFolderHandle();
    expect(await store.loadFolderHandle()).toBeNull();
  });

  it("ignores a stored value that is not a directory handle", async () => {
    const { store, open } = freshStore();
    await idbPut(await open(), "handles", { kind: "file", name: "x" }, "folder");
    expect(await store.loadFolderHandle()).toBeNull();
  });

  it("stores the last folder scan time", async () => {
    const { store } = freshStore();
    expect(await store.getLastFolderScanAt()).toBeNull();
    await store.setLastFolderScanAt(NOW);
    expect(await store.getLastFolderScanAt()).toBe(NOW);
    await store.clearAll();
    expect(await store.getLastFolderScanAt()).toBeNull();
  });

  it("surfaces an unavailable database and retries opening later", async () => {
    let attempts = 0;
    const store = createInstantLocalStore(() => {
      attempts += 1;
      return Promise.reject(new Error("storage disabled"));
    });
    await expect(store.loadLedger()).rejects.toThrow("storage disabled");
    await expect(store.loadLedger()).rejects.toThrow("storage disabled");
    expect(attempts).toBe(2);
  });
});

describe("connection lifecycle", () => {
  it("reopens after another tab deletes or upgrades the database (versionchange)", async () => {
    const factory = new IDBFactory();
    let opens = 0;
    const store = createInstantLocalStore(() => {
      opens += 1;
      return openInstantDb(factory);
    });
    await store.setLastFolderScanAt(NOW);
    // Another tab deletes the database: our connection gets versionchange and closes.
    await new Promise<void>((resolve, reject) => {
      const request = factory.deleteDatabase(INSTANT_DB_NAME);
      request.onsuccess = () => resolve();
      request.onerror = () => reject(request.error);
      request.onblocked = () => reject(new Error("blocked by our own connection"));
    });
    // The closed connection is not reused: the store reopens a fresh database.
    expect(await store.getLastFolderScanAt()).toBeNull();
    await store.setLastFolderScanAt(NOW + 1);
    expect(await store.getLastFolderScanAt()).toBe(NOW + 1);
    expect(opens).toBe(2);
  });
});
