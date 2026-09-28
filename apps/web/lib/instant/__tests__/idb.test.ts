import "fake-indexeddb/auto";
import { IDBFactory } from "fake-indexeddb";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  INSTANT_DB_NAME,
  INSTANT_DB_VERSION,
  InstantDbUnavailableError,
  TRY_GAMES_EXPIRES_INDEX,
  defaultIndexedDb,
  idbClear,
  idbCount,
  idbDelete,
  idbGet,
  idbGetAll,
  idbPut,
  idbPutMany,
  idbTransaction,
  openInstantDb,
  requestToPromise,
} from "../idb";

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("openInstantDb", () => {
  it("creates the four stores and the expiry index", async () => {
    const db = await openInstantDb(new IDBFactory());
    expect([...db.objectStoreNames].sort()).toEqual(["handles", "ledger", "meta", "tryGames"]);
    const tx = db.transaction("tryGames", "readonly");
    const store = tx.objectStore("tryGames");
    expect(store.keyPath).toBe("gameId");
    expect([...store.indexNames]).toEqual([TRY_GAMES_EXPIRES_INDEX]);
    expect(db.transaction("ledger").objectStore("ledger").keyPath).toBe("path");
    db.close();
  });

  it("fails with a typed error when IndexedDB is missing", async () => {
    vi.stubGlobal("indexedDB", undefined);
    const error = await openInstantDb().catch((e: unknown) => e);
    expect(error).toBeInstanceOf(InstantDbUnavailableError);
    expect(error).toMatchObject({ reason: "unsupported" });
  });

  it("fails with a typed error when open() throws (private mode)", async () => {
    // Mock factory: only open() is exercised, and it refuses like some private modes do.
    const refusing = {
      open: () => {
        throw new DOMException("denied", "SecurityError");
      },
    } as unknown as IDBFactory;
    const error = await openInstantDb(refusing).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(InstantDbUnavailableError);
    expect(error).toMatchObject({ reason: "open_failed", message: "SecurityError" });
  });

  it("closes itself on versionchange so a newer tab can upgrade", async () => {
    const factory = new IDBFactory();
    await openInstantDb(factory);
    const upgraded = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = factory.open(INSTANT_DB_NAME, INSTANT_DB_VERSION + 1);
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
      request.onblocked = () => reject(new Error("blocked by the old connection"));
    });
    expect(upgraded.version).toBe(INSTANT_DB_VERSION + 1);
    upgraded.close();
  });
});

describe("openInstantDb: unavailable or blocked", () => {
  it("fails with a typed error when reading indexedDB itself throws", async () => {
    // Some browsers throw a SecurityError from the accessor when storage is blocked.
    vi.stubGlobal("indexedDB", undefined);
    Object.defineProperty(globalThis, "indexedDB", {
      configurable: true,
      get() {
        throw new DOMException("denied", "SecurityError");
      },
    });
    expect(defaultIndexedDb()).toBeUndefined();
    const error = await openInstantDb().catch((e: unknown) => e);
    expect(error).toMatchObject({ name: "InstantDbUnavailableError", reason: "unsupported" });
  });

  it("rejects a blocked open instead of hanging, and closes a late connection", async () => {
    // Mock request: fake-indexeddb cannot block a version-1 open, which is
    // what an old tab without a versionchange handler does to a newer schema.
    const request: Partial<IDBOpenDBRequest> = {};
    const factory = { open: () => request } as unknown as IDBFactory;
    const opening = openInstantDb(factory);
    request.onblocked?.call(request as IDBOpenDBRequest, new Event("blocked") as IDBVersionChangeEvent);
    const error = await opening.catch((e: unknown) => e);
    expect(error).toBeInstanceOf(InstantDbUnavailableError);
    expect(error).toMatchObject({ reason: "blocked" });
    const close = vi.fn();
    Object.defineProperty(request, "result", { value: { close } });
    request.onsuccess?.call(request as IDBOpenDBRequest, new Event("success"));
    expect(close).toHaveBeenCalledTimes(1);
  });
});

describe("idb helpers", () => {
  it("round-trips values in keyPath and out-of-line stores", async () => {
    const db = await openInstantDb(new IDBFactory());
    await idbPut(db, "ledger", { path: "a", status: "uploaded" });
    await idbPut(db, "meta", 42, "answer");
    expect(await idbGet(db, "ledger", "a")).toEqual({ path: "a", status: "uploaded" });
    expect(await idbGet(db, "meta", "answer")).toBe(42);
    expect(await idbGet(db, "meta", "missing")).toBeUndefined();
    await idbDelete(db, "meta", "answer");
    expect(await idbGet(db, "meta", "answer")).toBeUndefined();
    db.close();
  });

  it("writes many rows atomically, counts, lists and clears", async () => {
    const db = await openInstantDb(new IDBFactory());
    await idbPutMany(db, "ledger", [{ path: "a" }, { path: "b" }]);
    await idbPutMany(db, "ledger", []);
    expect(await idbCount(db, "ledger")).toBe(2);
    expect(await idbGetAll(db, "ledger")).toEqual([{ path: "a" }, { path: "b" }]);
    await idbPut(db, "meta", 1, "k");
    await idbClear(db, ["ledger", "meta"]);
    expect(await idbCount(db, "ledger")).toBe(0);
    expect(await idbCount(db, "meta")).toBe(0);
    db.close();
  });

  it("rejects when a transaction aborts (e.g. a bad keyPath value)", async () => {
    const db = await openInstantDb(new IDBFactory());
    await expect(idbPutMany(db, "ledger", [{ path: "ok" }, { nope: true }])).rejects.toBeTruthy();
    // All-or-nothing: the valid row was rolled back too.
    expect(await idbCount(db, "ledger")).toBe(0);
    db.close();
  });

  it("resolves a transaction with the work's result after commit", async () => {
    const db = await openInstantDb(new IDBFactory());
    await idbPut(db, "meta", "v", "k");
    const box = await idbTransaction(db, "meta", "readonly", (tx) => {
      const out: { value: unknown } = { value: null };
      const request = tx.objectStore("meta").get("k");
      request.onsuccess = () => {
        out.value = request.result;
      };
      return out;
    });
    expect(box.value).toBe("v");
    const count = await requestToPromise(db.transaction("meta").objectStore("meta").count());
    expect(count).toBe(1);
    db.close();
  });
});
