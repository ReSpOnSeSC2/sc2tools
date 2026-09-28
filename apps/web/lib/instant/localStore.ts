/**
 * Device-local persistence for Instant Analysis (IndexedDB via idb.ts).
 *
 *   - /try games: parsed payloads kept for 7 days so a visitor can
 *     come back to their report or claim the games after signing up.
 *     Expired rows are purged before every read.
 *   - Folder Sync ledger: per-file status so re-scans skip settled files.
 *   - Folder Sync directory handle (structured-cloned by the browser).
 *   - Small metadata such as the last folder scan time.
 *
 * Everything read back is validated (storage can hold older shapes).
 * Nothing here ever leaves the device.
 *
 * Example:
 *   await saveTryGames([{ gameId, json, date }], Date.now());
 *   const games = await loadTryGames(Date.now());
 */
import {
  TRY_GAMES_EXPIRES_INDEX,
  idbClear,
  idbCount,
  idbDelete,
  idbGet,
  idbGetAll,
  idbPut,
  idbPutMany,
  idbTransaction,
  openInstantDb,
} from "./idb";
import { isErrorKind, type LedgerEntry, type LedgerStatus } from "./ledger";
import { isDirectoryHandle, type DirectoryHandleLike } from "./folderSync";

/** /try games are kept on this device for 7 days. */
export const TRY_TTL_MS = 7 * 24 * 60 * 60 * 1000;

const FOLDER_HANDLE_KEY = "folder";
const LAST_FOLDER_SCAN_KEY = "lastFolderScanAt";

export interface TryGameInput {
  gameId: string;
  /** Compact payload JSON exactly as the engine produced it. */
  json: string;
  /** Replay date (RFC 3339). */
  date: string;
}

export interface StoredTryGame extends TryGameInput {
  storedAt: number;
  expiresAt: number;
}

export interface InstantLocalStore {
  saveTryGames(games: ReadonlyArray<TryGameInput>, now: number): Promise<void>;
  loadTryGames(now: number): Promise<StoredTryGame[]>;
  countTryGames(now: number): Promise<number>;
  purgeExpired(now: number): Promise<number>;
  clearTryData(): Promise<void>;
  loadLedger(): Promise<LedgerEntry[]>;
  saveLedgerEntries(entries: ReadonlyArray<LedgerEntry>): Promise<void>;
  clearLedger(): Promise<void>;
  saveFolderHandle(handle: DirectoryHandleLike): Promise<void>;
  loadFolderHandle(): Promise<DirectoryHandleLike | null>;
  clearFolderHandle(): Promise<void>;
  getLastFolderScanAt(): Promise<number | null>;
  setLastFolderScanAt(at: number): Promise<void>;
  clearAll(): Promise<void>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function toStoredTryGame(value: unknown): StoredTryGame | null {
  if (!isRecord(value)) return null;
  const { gameId, json, date, storedAt, expiresAt } = value;
  if (typeof gameId !== "string" || typeof json !== "string" || typeof date !== "string") {
    return null;
  }
  if (!isFiniteNumber(storedAt) || !isFiniteNumber(expiresAt)) return null;
  return { gameId, json, date, storedAt, expiresAt };
}

const LEDGER_STATUSES: ReadonlyArray<LedgerStatus> = ["uploaded", "skipped", "failed"];

function isLedgerStatus(value: unknown): value is LedgerStatus {
  return LEDGER_STATUSES.some((status) => status === value);
}

function toLedgerEntry(value: unknown): LedgerEntry | null {
  if (!isRecord(value)) return null;
  const { path, size, lastModified, status, gameId, errorKind, updatedAt } = value;
  if (typeof path !== "string" || !isLedgerStatus(status)) return null;
  if (!isFiniteNumber(size) || !isFiniteNumber(lastModified) || !isFiniteNumber(updatedAt)) {
    return null;
  }
  const entry: LedgerEntry = { path, size, lastModified, status, updatedAt };
  if (typeof gameId === "string") entry.gameId = gameId;
  // An unknown kind from a newer app version is dropped rather than trusted.
  if (typeof errorKind === "string" && isErrorKind(errorKind)) entry.errorKind = errorKind;
  return entry;
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
        storedAt: now,
        expiresAt: now + TRY_TTL_MS,
      }));
      await idbPutMany(await db(), "tryGames", rows);
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

type FolderSyncMethods = Omit<InstantLocalStore, keyof TryGameMethods | "clearAll">;

function folderSyncMethods(db: DbGetter): FolderSyncMethods {
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
    async saveFolderHandle(handle) {
      await idbPut(await db(), "handles", handle, FOLDER_HANDLE_KEY);
    },
    async loadFolderHandle() {
      const value = await idbGet(await db(), "handles", FOLDER_HANDLE_KEY);
      return isDirectoryHandle(value) ? value : null;
    },
    async clearFolderHandle() {
      await idbDelete(await db(), "handles", FOLDER_HANDLE_KEY);
    },
    async getLastFolderScanAt() {
      const value = await idbGet(await db(), "meta", LAST_FOLDER_SCAN_KEY);
      return isFiniteNumber(value) ? value : null;
    },
    async setLastFolderScanAt(at) {
      await idbPut(await db(), "meta", at, LAST_FOLDER_SCAN_KEY);
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
    ...folderSyncMethods(db),
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
 * Save parsed /try games (upsert; refreshes the 7-day expiry).
 *
 * Example:
 *   await saveTryGames([{ gameId, json, date }], Date.now());
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
 * Every valid Folder Sync ledger entry.
 *
 * Example:
 *   const ledger = await loadLedger();
 */
export function loadLedger(): Promise<LedgerEntry[]> {
  return instantLocalStore().loadLedger();
}

/**
 * Upsert ledger entries (one atomic transaction).
 *
 * Example:
 *   await saveLedgerEntries([ledgerEntryFor(file, "uploaded", Date.now(), { gameId })]);
 */
export function saveLedgerEntries(entries: ReadonlyArray<LedgerEntry>): Promise<void> {
  return instantLocalStore().saveLedgerEntries(entries);
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
 * Persist the picked replays folder handle.
 *
 * Example:
 *   await saveFolderHandle(root);
 */
export function saveFolderHandle(handle: DirectoryHandleLike): Promise<void> {
  return instantLocalStore().saveFolderHandle(handle);
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
 * Forget the persisted folder handle ("Stop syncing this folder").
 *
 * Example:
 *   await clearFolderHandle();
 */
export function clearFolderHandle(): Promise<void> {
  return instantLocalStore().clearFolderHandle();
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
 * Record a completed folder scan.
 *
 * Example:
 *   await setLastFolderScanAt(Date.now());
 */
export function setLastFolderScanAt(at: number): Promise<void> {
  return instantLocalStore().setLastFolderScanAt(at);
}
