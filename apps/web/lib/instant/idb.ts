/**
 * Minimal promise wrapper over IndexedDB for Instant Analysis (no
 * dependency). One database, four stores:
 *
 *   tryGames — parsed /try games kept for 7 days (keyPath `gameId`,
 *              index `expiresAt` for the expiry sweep)
 *   ledger   — Folder Sync per-file status (keyPath `path`)
 *   handles  — the persisted Folder Sync directory handle (key "folder")
 *   meta     — small key/value settings (e.g. last folder scan time)
 *
 * Values come back as `unknown`: storage is outside the type system
 * (older schema, another tab, manual edits), so callers narrow them.
 * Opening fails with a typed `InstantDbUnavailableError` when IndexedDB
 * is missing or refused (e.g. some private-browsing modes, or reading
 * `indexedDB` itself throws a SecurityError), or when the open is
 * blocked by another tab holding an older connection open.
 *
 * Example:
 *   const db = await openInstantDb();
 *   await idbPut(db, "meta", 1234, "lastFolderScanAt");
 *   const value: unknown = await idbGet(db, "meta", "lastFolderScanAt");
 */

export const INSTANT_DB_NAME = "sc2tools-instant";
export const INSTANT_DB_VERSION = 1;

export type InstantStoreName = "tryGames" | "ledger" | "handles" | "meta";

export const TRY_GAMES_EXPIRES_INDEX = "expiresAt";

/**
 * `blocked`: another tab keeps an older connection open and did not close
 * it on `versionchange`; the visitor has to close that tab.
 */
export type InstantDbFailure = "unsupported" | "open_failed" | "blocked";

/** IndexedDB cannot be used in this browser session. */
export class InstantDbUnavailableError extends Error {
  readonly reason: InstantDbFailure;

  constructor(reason: InstantDbFailure, message: string) {
    super(message);
    this.name = "InstantDbUnavailableError";
    this.reason = reason;
  }
}

function createSchema(db: IDBDatabase): void {
  if (!db.objectStoreNames.contains("tryGames")) {
    const tryGames = db.createObjectStore("tryGames", { keyPath: "gameId" });
    tryGames.createIndex(TRY_GAMES_EXPIRES_INDEX, "expiresAt");
  }
  if (!db.objectStoreNames.contains("ledger")) {
    db.createObjectStore("ledger", { keyPath: "path" });
  }
  if (!db.objectStoreNames.contains("handles")) db.createObjectStore("handles");
  if (!db.objectStoreNames.contains("meta")) db.createObjectStore("meta");
}

/**
 * `globalThis.indexedDB`, or undefined when it is missing or reading it
 * throws (some browsers raise a SecurityError when storage is blocked).
 *
 * Example:
 *   const factory = defaultIndexedDb(); // IDBFactory | undefined
 */
export function defaultIndexedDb(): IDBFactory | undefined {
  try {
    return globalThis.indexedDB;
  } catch {
    // Storage access is denied for this document; treated as unsupported.
    return undefined;
  }
}

/**
 * Open (and create or upgrade) the Instant Analysis database.
 *
 * Example:
 *   try { db = await openInstantDb(); } catch (e) {
 *     if (e instanceof InstantDbUnavailableError) showNoStorageNotice();
 *   }
 */
export function openInstantDb(
  factory: IDBFactory | undefined = defaultIndexedDb(),
): Promise<IDBDatabase> {
  if (!factory) {
    return Promise.reject(
      new InstantDbUnavailableError("unsupported", "IndexedDB is not available"),
    );
  }
  return new Promise<IDBDatabase>((resolve, reject) => {
    let request: IDBOpenDBRequest;
    try {
      request = factory.open(INSTANT_DB_NAME, INSTANT_DB_VERSION);
    } catch (error) {
      reject(new InstantDbUnavailableError("open_failed", errorName(error)));
      return;
    }
    watchOpenRequest(request, resolve, reject);
  });
}

/**
 * Wire an open request to its promise. A `blocked` open rejects at once
 * (the caller can ask the visitor to close other tabs) instead of hanging;
 * if the request later succeeds anyway, that stray connection is closed.
 */
function watchOpenRequest(
  request: IDBOpenDBRequest,
  resolve: (db: IDBDatabase) => void,
  reject: (error: InstantDbUnavailableError) => void,
): void {
  let settled = false;
  request.onupgradeneeded = () => createSchema(request.result);
  request.onsuccess = () => {
    const db = request.result;
    if (settled) {
      db.close();
      return;
    }
    settled = true;
    // Let a newer tab upgrade the schema instead of blocking it.
    db.onversionchange = () => db.close();
    resolve(db);
  };
  request.onerror = () => {
    settled = true;
    reject(new InstantDbUnavailableError("open_failed", errorName(request.error)));
  };
  request.onblocked = () => {
    settled = true;
    reject(new InstantDbUnavailableError("blocked", "IndexedDB open is blocked by another tab"));
  };
}

function errorName(error: unknown): string {
  if (error instanceof Error) return error.name;
  if (error && typeof error === "object" && "name" in error && typeof error.name === "string") {
    return error.name;
  }
  return "IndexedDB open failed";
}

/**
 * Resolve a single IDB request.
 *
 * Example:
 *   const count = await requestToPromise(store.count());
 */
export function requestToPromise<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error("IndexedDB request failed"));
  });
}

/**
 * Run `work` inside one transaction and resolve with its return value
 * once the transaction COMMITS (so writes are durable), rejecting on
 * error or abort. `work` must only queue requests synchronously; fill
 * the returned object from request callbacks to gather results.
 *
 * Example:
 *   const out = await idbTransaction(db, ["ledger"], "readonly", (tx) => {
 *     const box: { rows: unknown[] } = { rows: [] };
 *     const req = tx.objectStore("ledger").getAll();
 *     req.onsuccess = () => { box.rows = req.result; };
 *     return box;
 *   });
 */
export function idbTransaction<R>(
  db: IDBDatabase,
  stores: InstantStoreName | InstantStoreName[],
  mode: IDBTransactionMode,
  work: (tx: IDBTransaction) => R,
): Promise<R> {
  return new Promise<R>((resolve, reject) => {
    let tx: IDBTransaction;
    try {
      tx = db.transaction(stores, mode);
    } catch (error) {
      reject(error);
      return;
    }
    let result: R;
    try {
      result = work(tx);
    } catch (error) {
      // A synchronous throw (e.g. DataError from put) must not let the
      // requests queued before it commit: all or nothing.
      abortQuietly(tx);
      reject(error);
      return;
    }
    tx.oncomplete = () => resolve(result);
    tx.onerror = () => reject(tx.error ?? new Error("IndexedDB transaction failed"));
    tx.onabort = () => reject(tx.error ?? new Error("IndexedDB transaction aborted"));
  });
}

function abortQuietly(tx: IDBTransaction): void {
  try {
    tx.abort();
  } catch {
    // Already committed or aborted: nothing left to roll back.
  }
}

/**
 * Read one value (undefined when absent).
 *
 * Example:
 *   const handle: unknown = await idbGet(db, "handles", "folder");
 */
export async function idbGet(
  db: IDBDatabase,
  store: InstantStoreName,
  key: IDBValidKey,
): Promise<unknown> {
  const box: { value: unknown } = { value: undefined };
  await idbTransaction(db, store, "readonly", (tx) => {
    const request: IDBRequest<unknown> = tx.objectStore(store).get(key);
    request.onsuccess = () => {
      box.value = request.result;
    };
  });
  return box.value;
}

/**
 * Write one value. Pass `key` only for stores without a keyPath
 * (`handles`, `meta`).
 *
 * Example:
 *   await idbPut(db, "ledger", entry);
 */
export async function idbPut(
  db: IDBDatabase,
  store: InstantStoreName,
  value: unknown,
  key?: IDBValidKey,
): Promise<void> {
  await idbTransaction(db, store, "readwrite", (tx) => {
    const target = tx.objectStore(store);
    if (key === undefined) target.put(value);
    else target.put(value, key);
  });
}

/**
 * Write many values atomically (all or nothing).
 *
 * Example:
 *   await idbPutMany(db, "ledger", entries);
 */
export async function idbPutMany(
  db: IDBDatabase,
  store: InstantStoreName,
  values: ReadonlyArray<unknown>,
): Promise<void> {
  if (values.length === 0) return;
  await idbTransaction(db, store, "readwrite", (tx) => {
    const target = tx.objectStore(store);
    for (const value of values) target.put(value);
  });
}

/**
 * Delete one key (no error when absent).
 *
 * Example:
 *   await idbDelete(db, "handles", "folder");
 */
export async function idbDelete(
  db: IDBDatabase,
  store: InstantStoreName,
  key: IDBValidKey | IDBKeyRange,
): Promise<void> {
  await idbTransaction(db, store, "readwrite", (tx) => {
    tx.objectStore(store).delete(key);
  });
}

/**
 * Read every value in a store.
 *
 * Example:
 *   const rows = await idbGetAll(db, "ledger");
 */
export async function idbGetAll(
  db: IDBDatabase,
  store: InstantStoreName,
): Promise<unknown[]> {
  const box: { rows: unknown[] } = { rows: [] };
  await idbTransaction(db, store, "readonly", (tx) => {
    const request: IDBRequest<unknown[]> = tx.objectStore(store).getAll();
    request.onsuccess = () => {
      box.rows = request.result;
    };
  });
  return box.rows;
}

/**
 * Count the values in a store.
 *
 * Example:
 *   const n = await idbCount(db, "tryGames");
 */
export async function idbCount(db: IDBDatabase, store: InstantStoreName): Promise<number> {
  const box = { count: 0 };
  await idbTransaction(db, store, "readonly", (tx) => {
    const request = tx.objectStore(store).count();
    request.onsuccess = () => {
      box.count = request.result;
    };
  });
  return box.count;
}

/**
 * Remove every value from one or more stores in one transaction.
 *
 * Example:
 *   await idbClear(db, ["tryGames", "meta"]);
 */
export async function idbClear(
  db: IDBDatabase,
  stores: InstantStoreName | InstantStoreName[],
): Promise<void> {
  const names = Array.isArray(stores) ? stores : [stores];
  await idbTransaction(db, names, "readwrite", (tx) => {
    for (const name of names) tx.objectStore(name).clear();
  });
}
