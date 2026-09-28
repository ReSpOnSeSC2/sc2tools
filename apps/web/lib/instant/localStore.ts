/**
 * Device-local persistence for Instant Analysis (IndexedDB via idb.ts).
 *
 *   - /try games: parsed payloads kept for 7 days so a visitor can
 *     come back to their report or claim the games after signing up.
 *     Expired rows are purged before every read, and at most
 *     `MAX_STORED_TRY_GAMES` are kept (oldest-stored dropped on save).
 *   - Folder Sync ledger: per-file status so re-scans skip settled files.
 *   - Folder Sync directory handle (structured-cloned by the browser).
 *   - Small metadata: the last folder scan time, the account the Folder
 *     Sync state belongs to, and an auto-sync pause after the daily
 *     browser-upload cap.
 *
 * Folder Sync state is bound to ONE account: binding a different account
 * (`saveFolderHandle` / `claimFolderSync`) forgets the previous account's
 * ledger and scan time in the same transaction, so a shared browser never
 * syncs one person's replays into another person's account.
 *
 * Everything read back is validated (localStoreRows.ts). Nothing here
 * ever leaves the device.
 *
 * Example:
 *   await saveTryGames([{ gameId, json, date, engineVersion }], Date.now());
 *   const games = await loadTryGames(Date.now());
 */
import {
  TRY_GAMES_EXPIRES_INDEX,
  idbClear,
  idbCount,
  idbGet,
  idbGetAll,
  idbPut,
  idbPutMany,
  idbTransaction,
  openInstantDb,
} from "./idb";
import type { LedgerEntry } from "./ledger";
import { isDirectoryHandle, type DirectoryHandleLike } from "./folderSync";
import {
  MAX_STORED_TRY_GAMES,
  TRY_TTL_MS,
  isFiniteNumber,
  newestStoredFirst,
  toIngestPause,
  toLedgerEntry,
  toStoredTryGame,
  type StoredTryGame,
  type TryGameInput,
} from "./localStoreRows";

export { MAX_STORED_TRY_GAMES, TRY_TTL_DAYS, TRY_TTL_MS } from "./localStoreRows";
export type { StoredTryGame, TryGameInput } from "./localStoreRows";

const FOLDER_HANDLE_KEY = "folder";
const LAST_FOLDER_SCAN_KEY = "lastFolderScanAt";
const FOLDER_OWNER_KEY = "folderOwner";
const INGEST_PAUSE_KEY = "browserIngestPausedUntil";

export interface InstantLocalStore {
  saveTryGames(games: ReadonlyArray<TryGameInput>, now: number): Promise<void>;
  loadTryGames(now: number): Promise<StoredTryGame[]>;
  countTryGames(now: number): Promise<number>;
  purgeExpired(now: number): Promise<number>;
  clearTryData(): Promise<void>;
  loadLedger(): Promise<LedgerEntry[]>;
  saveLedgerEntries(entries: ReadonlyArray<LedgerEntry>): Promise<void>;
  clearLedger(): Promise<void>;
  /** Remember the folder for `ownerUserId` (a different owner's ledger is forgotten). */
  saveFolderHandle(handle: DirectoryHandleLike, ownerUserId: string): Promise<void>;
  loadFolderHandle(): Promise<DirectoryHandleLike | null>;
  /** Forget the folder, its owner and its last scan time. */
  clearFolderHandle(): Promise<void>;
  /** The account the Folder Sync state belongs to, or null. */
  getFolderOwner(): Promise<string | null>;
  /** Bind the Folder Sync state to `ownerUserId` (a different owner's ledger is forgotten). */
  claimFolderSync(ownerUserId: string): Promise<void>;
  getLastFolderScanAt(): Promise<number | null>;
  setLastFolderScanAt(at: number): Promise<void>;
  /** Epoch ms until which `userId`'s auto-sync waits (daily cap), or null. */
  getIngestPausedUntil(userId: string): Promise<number | null>;
  setIngestPausedUntil(userId: string, until: number): Promise<void>;
  clearAll(): Promise<void>;
}

async function purgeExpiredIn(db: IDBDatabase, now: number): Promise<number> {
  return idbTransaction(db, "tryGames", "readwrite", (tx) => {
    const box = { removed: 0 };
    const range = IDBKeyRange.upperBound(now);
    const request = tx.objectStore("tryGames").index(TRY_GAMES_EXPIRES_INDEX).openCursor(range);
    request.onsuccess = () => {
      const cursor = request.result;
      if (!cursor) return;
      cursor.delete();
      box.removed += 1;
      cursor.continue();
    };
    return box;
  }).then((box) => box.removed);
}

/** Queue a delete of every valid row beyond the newest `keep` (same transaction). */
function trimTryGames(store: IDBObjectStore, keep: number): void {
  const request: IDBRequest<unknown[]> = store.getAll();
  request.onsuccess = () => {
    const rows = request.result.flatMap((value) => toStoredTryGame(value) ?? []);
    rows.sort(newestStoredFirst).slice(keep).forEach((row) => store.delete(row.gameId));
  };
}

/**
 * Bind the Folder Sync state to `owner` inside `tx` (stores `meta` and
 * `ledger`): when the stored owner differs (or is missing), the ledger
 * and the last scan time belong to someone else and are forgotten.
 */
function bindOwner(tx: IDBTransaction, owner: string): void {
  const meta = tx.objectStore("meta");
  const request = meta.get(FOLDER_OWNER_KEY);
  request.onsuccess = () => {
    if (request.result !== owner) {
      tx.objectStore("ledger").clear();
      meta.delete(LAST_FOLDER_SCAN_KEY);
    }
    meta.put(owner, FOLDER_OWNER_KEY);
  };
}

type DbGetter = () => Promise<IDBDatabase>;

type TryGameMethods = Pick<
  InstantLocalStore,
  "saveTryGames" | "loadTryGames" | "countTryGames" | "purgeExpired" | "clearTryData"
>;

function tryGameMethods(db: DbGetter): TryGameMethods {
  return {
    async saveTryGames(games, now) {
      const rows: StoredTryGame[] = games.map((game) => ({
        gameId: game.gameId,
        json: game.json,
        date: game.date,
        engineVersion: game.engineVersion,
        storedAt: now,
        expiresAt: now + TRY_TTL_MS,
      }));
      if (rows.length === 0) return;
      await idbTransaction(await db(), "tryGames", "readwrite", (tx) => {
        const store = tx.objectStore("tryGames");
        for (const row of rows) store.put(row);
        trimTryGames(store, MAX_STORED_TRY_GAMES);
      });
    },
    async loadTryGames(now) {
      const conn = await db();
      await purgeExpiredIn(conn, now);
      const rows = (await idbGetAll(conn, "tryGames")).map(toStoredTryGame);
      return rows
        .filter((row): row is StoredTryGame => row !== null)
        .sort((a, b) => b.date.localeCompare(a.date));
    },
    async countTryGames(now) {
      const conn = await db();
      await purgeExpiredIn(conn, now);
      return idbCount(conn, "tryGames");
    },
    async purgeExpired(now) {
      return purgeExpiredIn(await db(), now);
    },
    async clearTryData() {
      await idbClear(await db(), "tryGames");
    },
  };
}

type LedgerMethods = Pick<InstantLocalStore, "loadLedger" | "saveLedgerEntries" | "clearLedger">;

function ledgerMethods(db: DbGetter): LedgerMethods {
  return {
    async loadLedger() {
      const rows = (await idbGetAll(await db(), "ledger")).map(toLedgerEntry);
      return rows.filter((row): row is LedgerEntry => row !== null);
    },
    async saveLedgerEntries(entries) {
      await idbPutMany(await db(), "ledger", entries);
    },
    async clearLedger() {
      await idbClear(await db(), "ledger");
    },
  };
}

type FolderMethods = Omit<InstantLocalStore, keyof TryGameMethods | keyof LedgerMethods | "clearAll">;

function folderMethods(db: DbGetter): FolderMethods {
  return {
    async saveFolderHandle(handle, ownerUserId) {
      await idbTransaction(await db(), ["handles", "meta", "ledger"], "readwrite", (tx) => {
        tx.objectStore("handles").put(handle, FOLDER_HANDLE_KEY);
        bindOwner(tx, ownerUserId);
      });
    },
    async loadFolderHandle() {
      const value = await idbGet(await db(), "handles", FOLDER_HANDLE_KEY);
      return isDirectoryHandle(value) ? value : null;
    },
    async clearFolderHandle() {
      await idbTransaction(await db(), ["handles", "meta"], "readwrite", (tx) => {
        tx.objectStore("handles").delete(FOLDER_HANDLE_KEY);
        const meta = tx.objectStore("meta");
        meta.delete(FOLDER_OWNER_KEY);
        meta.delete(LAST_FOLDER_SCAN_KEY);
      });
    },
    async getFolderOwner() {
      const value = await idbGet(await db(), "meta", FOLDER_OWNER_KEY);
      return typeof value === "string" && value ? value : null;
    },
    async claimFolderSync(ownerUserId) {
      await idbTransaction(await db(), ["meta", "ledger"], "readwrite", (tx) => bindOwner(tx, ownerUserId));
    },
    async getLastFolderScanAt() {
      const value = await idbGet(await db(), "meta", LAST_FOLDER_SCAN_KEY);
      return isFiniteNumber(value) ? value : null;
    },
    async setLastFolderScanAt(at) {
      await idbPut(await db(), "meta", at, LAST_FOLDER_SCAN_KEY);
    },
    async getIngestPausedUntil(userId) {
      const pause = toIngestPause(await idbGet(await db(), "meta", INGEST_PAUSE_KEY));
      return pause && pause.userId === userId ? pause.until : null;
    },
    async setIngestPausedUntil(userId, until) {
      await idbPut(await db(), "meta", { userId, until }, INGEST_PAUSE_KEY);
    },
  };
}

/**
 * Build a store over a lazily opened database. Pass a custom opener in
 * tests (e.g. a fresh `fake-indexeddb` factory per test).
 *
 * Example:
 *   const store = createInstantLocalStore(() => openInstantDb(new IDBFactory()));
 */
export function createInstantLocalStore(
  open: DbGetter = () => openInstantDb(),
): InstantLocalStore {
  let dbPromise: Promise<IDBDatabase> | null = null;
  const forget = (stale: Promise<IDBDatabase>) => {
    if (dbPromise === stale) dbPromise = null;
  };
  const db: DbGetter = () => {
    if (!dbPromise) {
      const opening = open().then(
        (conn) => {
          // A newer tab's upgrade (versionchange) or the browser (close)
          // ends this connection; reopen on the next call instead of
          // failing every later transaction with InvalidStateError.
          conn.addEventListener("versionchange", () => forget(opening));
          conn.addEventListener("close", () => forget(opening));
          return conn;
        },
        (error: unknown) => {
          forget(opening); // allow a later retry (e.g. storage re-enabled)
          throw error;
        },
      );
      dbPromise = opening;
    }
    return dbPromise;
  };
  return {
    ...tryGameMethods(db),
    ...ledgerMethods(db),
    ...folderMethods(db),
    async clearAll() {
      await idbClear(await db(), ["tryGames", "ledger", "handles", "meta"]);
    },
  };
}

let defaultStore: InstantLocalStore | null = null;

/**
 * The shared store over `globalThis.indexedDB`.
 *
 * Example:
 *   await instantLocalStore().clearAll();
 */
export function instantLocalStore(): InstantLocalStore {
  if (!defaultStore) defaultStore = createInstantLocalStore();
  return defaultStore;
}

/**
 * Save parsed /try games (upsert; refreshes the 7-day expiry; keeps at
 * most `MAX_STORED_TRY_GAMES`, dropping the oldest-stored ones).
 *
 * Example:
 *   await saveTryGames([{ gameId, json, date, engineVersion }], Date.now());
 */
export function saveTryGames(games: ReadonlyArray<TryGameInput>, now: number): Promise<void> {
  return instantLocalStore().saveTryGames(games, now);
}

/**
 * Load unexpired /try games, newest first (purges expired rows first).
 *
 * Example:
 *   const games = await loadTryGames(Date.now());
 */
export function loadTryGames(now: number): Promise<StoredTryGame[]> {
  return instantLocalStore().loadTryGames(now);
}

/**
 * Number of unexpired /try games on this device.
 *
 * Example:
 *   const n = await countTryGames(Date.now());
 */
export function countTryGames(now: number): Promise<number> {
  return instantLocalStore().countTryGames(now);
}

/**
 * Delete /try games whose 7 days are up; returns how many were removed.
 *
 * Example:
 *   await purgeExpired(Date.now());
 */
export function purgeExpired(now: number): Promise<number> {
  return instantLocalStore().purgeExpired(now);
}

/**
 * Forget every /try game on this device.
 *
 * Example:
 *   await clearTryData();
 */
export function clearTryData(): Promise<void> {
  return instantLocalStore().clearTryData();
}

/**
 * Forget the Folder Sync ledger (next scan re-checks every file).
 *
 * Example:
 *   await clearLedger();
 */
export function clearLedger(): Promise<void> {
  return instantLocalStore().clearLedger();
}

/**
 * Persist the picked replays folder handle for the signed-in account.
 *
 * Example:
 *   await saveFolderHandle(root, userId);
 */
export function saveFolderHandle(handle: DirectoryHandleLike, ownerUserId: string): Promise<void> {
  return instantLocalStore().saveFolderHandle(handle, ownerUserId);
}

/**
 * The persisted folder handle, or null.
 *
 * Example:
 *   const root = await loadFolderHandle();
 */
export function loadFolderHandle(): Promise<DirectoryHandleLike | null> {
  return instantLocalStore().loadFolderHandle();
}

/**
 * Forget the persisted folder handle, its owner and last scan time
 * ("Stop syncing this folder").
 *
 * Example:
 *   await clearFolderHandle();
 */
export function clearFolderHandle(): Promise<void> {
  return instantLocalStore().clearFolderHandle();
}

/**
 * The account (Clerk user id) the Folder Sync state belongs to, or null.
 *
 * Example:
 *   if ((await getFolderOwner()) !== userId) showRebindPrompt();
 */
export function getFolderOwner(): Promise<string | null> {
  return instantLocalStore().getFolderOwner();
}

/**
 * Bind Folder Sync on this device to `ownerUserId` (only ever from the
 * user's own click). Another account's ledger and scan time are forgotten.
 *
 * Example:
 *   await claimFolderSync(userId);
 */
export function claimFolderSync(ownerUserId: string): Promise<void> {
  return instantLocalStore().claimFolderSync(ownerUserId);
}

/**
 * Epoch ms of the last completed folder scan, or null.
 *
 * Example:
 *   shouldAutoScan(await getLastFolderScanAt(), Date.now());
 */
export function getLastFolderScanAt(): Promise<number | null> {
  return instantLocalStore().getLastFolderScanAt();
}

/**
 * When `userId`'s Folder Sync auto-sync may run again after the daily
 * browser-upload cap; null when not paused or storage is unavailable.
 *
 * Example:
 *   const until = await getBrowserIngestPausedUntil(userId);
 *   if (until !== null && Date.now() < until) return;
 */
export async function getBrowserIngestPausedUntil(userId: string): Promise<number | null> {
  try {
    return await instantLocalStore().getIngestPausedUntil(userId);
  } catch {
    return null; // storage blocked: nothing remembered, nothing paused
  }
}

/**
 * Pause `userId`'s Folder Sync auto-sync until `until` (epoch ms). Best
 * effort: a blocked store only loses the pause.
 *
 * Example:
 *   await setBrowserIngestPausedUntil(userId, resetAt);
 */
export async function setBrowserIngestPausedUntil(userId: string, until: number): Promise<void> {
  try {
    await instantLocalStore().setIngestPausedUntil(userId, until);
  } catch {
    // Storage blocked: the in-memory pause of this visit still applies.
  }
}
