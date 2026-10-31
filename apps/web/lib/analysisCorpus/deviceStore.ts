/**
 * Game history kept on this device for the analysis corpus that Daily Pulse, Season Recap and Arcade read. It is an
 * IndexedDB database of its own, apart from Instant Analysis, and it holds one account at a time:
 *
 *   accounts: keyPath `accountKey`, the account's choice to keep its history here, with the stored corpus's marks
 *             (corpus version, epoch and watermark) and row count; no marks means the choice stands with nothing usable
 *   games:    keyPath [`accountKey`, `gameId`], index `accountKey`, holding one strict analysis row each
 *
 * A snapshot replaces everything in one transaction, so another account's history never stays beside it. A delta
 * merges its rows and moves the marks in one transaction, and only while the stored marks are still the ones it
 * started from (another tab may have moved them). Stored values are `unknown` until checked, and a copy that does not
 * check out reads as unreadable, so the caller takes a fresh snapshot.
 *
 * Example:
 *   const db = await openDeviceCorpus(defaultIndexedDb(), { create: false });
 *   const stored = db ? await readDeviceCorpus(db, accountKey, 20_000) : null;
 */
import { idbTransactionOn } from "@/lib/instant/idb";
import { isRemoval, type CorpusChange, type CorpusMarks, type CorpusRow } from "./changes";

export const DEVICE_CORPUS_DB_NAME = "sc2tools-analysis-corpus";
const DEVICE_CORPUS_DB_VERSION = 1;
const DEVICE_CORPUS_SCHEMA = 1;
/** A healthy open takes milliseconds; past this the corpus loads in memory rather than waiting on storage. */
export const DEVICE_CORPUS_OPEN_DEADLINE_MS = 3000;
const ACCOUNTS = "accounts";
const GAMES = "games";
const BY_ACCOUNT = "accountKey";

/**
 * `kept`: the account keeps its history here but holds no usable copy (the last snapshot could not be stored), so its
 * next load takes a snapshot and stores it.
 */
export type DeviceCorpus<T extends CorpusRow> =
  | { kind: "absent" }
  | { kind: "kept" }
  | { kind: "unreadable" }
  | { kind: "stored"; marks: CorpusMarks; rows: T[] };

type AccountRecord = { accountKey: string; schema: number; marks: CorpusMarks | null; count: number; savedAt: string };

/**
 * Open the device corpus, or resolve null when IndexedDB is missing, refused or slower than `deadlineMs`; a
 * connection that arrives after the deadline is closed. With `create: false` it only probes: when nothing was ever
 * stored it creates nothing, calls `onAbsent` and resolves null.
 *
 * Example:
 *   const db = await openDeviceCorpus(defaultIndexedDb(), { create: true });
 */
export function openDeviceCorpus(
  factory: IDBFactory | undefined,
  { create, deadlineMs = DEVICE_CORPUS_OPEN_DEADLINE_MS, onAbsent }: {
    create: boolean;
    deadlineMs?: number;
    /** Called when the probe finds no database at all (not when IndexedDB is refused or slow). */
    onAbsent?: () => void;
  },
): Promise<IDBDatabase | null> {
  if (!factory) return Promise.resolve(null);
  return new Promise((resolve, reject) => {
    let request: IDBOpenDBRequest;
    try {
      request = factory.open(DEVICE_CORPUS_DB_NAME, DEVICE_CORPUS_DB_VERSION);
    } catch {
      // Storage is refused for this document (e.g. a SecurityError): there is no device copy to use.
      resolve(null);
      return;
    }
    let settled = false;
    let absent = false;
    const deadline = setTimeout(() => {
      settled = true;
      resolve(null);
    }, deadlineMs);
    const settle = (finish: () => void) => {
      clearTimeout(deadline);
      if (settled) return;
      settled = true;
      finish();
    };
    request.onupgradeneeded = (event) => {
      if (!create && event.oldVersion === 0) {
        // Aborting the first upgrade leaves no database behind.
        absent = true;
        request.transaction?.abort();
        return;
      }
      createSchema(request.result);
    };
    request.onsuccess = () => {
      const db = request.result;
      // A newer schema opened in another tab takes over; this connection steps aside.
      db.onversionchange = () => db.close();
      if (settled) db.close();
      settle(() => resolve(db));
    };
    request.onerror = (event) => {
      event.preventDefault();
      settle(() => {
        if (!absent) {
          reject(request.error ?? new Error("device corpus open failed"));
          return;
        }
        onAbsent?.();
        resolve(null);
      });
    };
  });
}

/**
 * Read one account's stored corpus. Rows come back in key order; the caller orders them for display.
 *
 * Example:
 *   const stored = await readDeviceCorpus<AnalysisApiGame>(db, accountKey, 20_000);
 *   if (stored.kind === "stored") render(stored.rows);
 */
export async function readDeviceCorpus<T extends CorpusRow>(
  db: IDBDatabase,
  accountKey: string,
  maxRows: number,
): Promise<DeviceCorpus<T>> {
  const box = await idbTransactionOn(db, [ACCOUNTS, GAMES], "readonly", (tx) => {
    const out: { account?: unknown; records?: unknown } = {};
    const account = tx.objectStore(ACCOUNTS).get(accountKey);
    account.onsuccess = () => { out.account = account.result; };
    const records = tx.objectStore(GAMES).index(BY_ACCOUNT).getAll(accountKey);
    records.onsuccess = () => { out.records = records.result; };
    return out;
  });
  if (box.account === undefined) return { kind: "absent" };
  const account = accountRecord(box.account, accountKey);
  const rows = account && account.count <= maxRows ? storedRows<T>(box.records, accountKey) : null;
  if (!account || !rows || rows.length !== account.count) return { kind: "unreadable" };
  return account.marks ? { kind: "stored", marks: account.marks, rows } : { kind: "kept" };
}

/**
 * Replace everything on this device with one account's snapshot and its marks, in one transaction.
 *
 * Example:
 *   await saveDeviceSnapshot(db, accountKey, items, marks, 20_000);
 */
export function saveDeviceSnapshot<T extends CorpusRow>(
  db: IDBDatabase,
  accountKey: string,
  rows: readonly T[],
  marks: CorpusMarks,
  maxRows: number,
): Promise<void> {
  const unique = new Map(rows.map((row) => [row.gameId, row]));
  if (unique.size > maxRows) return Promise.reject(new Error("device corpus row limit"));
  return idbTransactionOn(db, [ACCOUNTS, GAMES], "readwrite", (tx) => {
    const accounts = tx.objectStore(ACCOUNTS);
    const games = tx.objectStore(GAMES);
    accounts.clear();
    games.clear();
    for (const [gameId, row] of unique) games.put({ accountKey, gameId, row });
    accounts.put(accountRecordFor(accountKey, marks, unique.size));
  });
}

/**
 * Drop every stored row, keeping only this account's choice to keep its history here, in one transaction. Its next
 * load takes a snapshot instead of showing a copy that could not be brought up to date.
 *
 * Example:
 *   await resetDeviceCorpus(db, accountKey);
 */
export function resetDeviceCorpus(db: IDBDatabase, accountKey: string): Promise<void> {
  return idbTransactionOn(db, [ACCOUNTS, GAMES], "readwrite", (tx) => {
    const accounts = tx.objectStore(ACCOUNTS);
    tx.objectStore(GAMES).clear();
    accounts.clear();
    accounts.put(accountRecordFor(accountKey, null, 0));
  });
}

/**
 * Delete the whole device copy, the last resort when a copy can be neither replaced nor reset. Other tabs' connections
 * step aside on versionchange, and the request finishes once they have; nothing waits for it.
 *
 * Example:
 *   deleteDeviceCorpus(defaultIndexedDb());
 */
export function deleteDeviceCorpus(factory: IDBFactory | undefined): void {
  try {
    const request = factory?.deleteDatabase(DEVICE_CORPUS_DB_NAME);
    if (request) request.onerror = (event) => event.preventDefault();
  } catch {
    // Storage is refused for this document: there is nothing to delete.
  }
}

/**
 * Merge a delta into the stored corpus and move its marks to `to`, in one transaction. Resolves false and writes
 * nothing when the stored marks are no longer `from` (another tab moved them) or the merge would pass `maxRows`.
 *
 * Example:
 *   const merged = await mergeDeviceDelta(db, accountKey, stored.marks, delta.changes, delta.marks, 20_000);
 */
export async function mergeDeviceDelta<T extends CorpusRow>(
  db: IDBDatabase,
  accountKey: string,
  from: CorpusMarks,
  changes: readonly CorpusChange<T>[],
  to: CorpusMarks,
  maxRows: number,
): Promise<boolean> {
  const outcome = { merged: false, overLimit: false };
  try {
    await idbTransactionOn(db, [ACCOUNTS, GAMES], "readwrite", (tx) => {
      const accounts = tx.objectStore(ACCOUNTS);
      const games = tx.objectStore(GAMES);
      const current = accounts.get(accountKey);
      current.onsuccess = () => {
        const marks = accountRecord(current.result, accountKey)?.marks;
        if (!marks || !sameMarks(marks, from)) return;
        for (const change of changes) {
          if (isRemoval(change)) games.delete([accountKey, change.gameId]);
          else games.put({ accountKey, gameId: change.gameId, row: change });
        }
        const counted = games.index(BY_ACCOUNT).count(accountKey);
        counted.onsuccess = () => {
          if (counted.result > maxRows) {
            outcome.overLimit = true;
            tx.abort();
            return;
          }
          accounts.put(accountRecordFor(accountKey, to, counted.result));
          outcome.merged = true;
        };
      };
      return outcome;
    });
  } catch (error) {
    // Passing the limit rolls the whole merge back; the stored copy stays as it was.
    if (outcome.overLimit) return false;
    throw error;
  }
  return outcome.merged;
}

function createSchema(db: IDBDatabase): void {
  if (!db.objectStoreNames.contains(ACCOUNTS)) db.createObjectStore(ACCOUNTS, { keyPath: "accountKey" });
  if (!db.objectStoreNames.contains(GAMES)) {
    db.createObjectStore(GAMES, { keyPath: ["accountKey", "gameId"] }).createIndex(BY_ACCOUNT, "accountKey");
  }
}

function sameMarks(a: CorpusMarks, b: CorpusMarks): boolean {
  return a.corpusVersion === b.corpusVersion && a.watermark === b.watermark && a.corpusEpoch === b.corpusEpoch;
}

function accountRecordFor(accountKey: string, marks: CorpusMarks | null, count: number): AccountRecord {
  return { accountKey, schema: DEVICE_CORPUS_SCHEMA, marks, count, savedAt: new Date().toISOString() };
}

function accountRecord(value: unknown, accountKey: string): AccountRecord | null {
  if (!value || typeof value !== "object") return null;
  const record = value as Partial<AccountRecord>;
  const countOk = Number.isSafeInteger(record.count) && (record.count as number) >= 0;
  const marksOk = record.marks === null ? record.count === 0 : storedMarks(record.marks);
  return record.accountKey === accountKey && record.schema === DEVICE_CORPUS_SCHEMA && countOk && marksOk
    ? (record as AccountRecord)
    : null;
}

function storedMarks(value: unknown): boolean {
  const marks = value as Partial<CorpusMarks> | null | undefined;
  return Boolean(marks) && typeof marks === "object"
    && Number.isSafeInteger(marks?.corpusVersion) && (marks?.corpusVersion as number) >= 0
    && typeof marks?.watermark === "string" && !Number.isNaN(Date.parse(marks.watermark))
    && typeof marks?.corpusEpoch === "string" && marks.corpusEpoch.length > 0;
}

function storedRows<T extends CorpusRow>(records: unknown, accountKey: string): T[] | null {
  if (!Array.isArray(records)) return null;
  const rows: T[] = [];
  for (const record of records as Array<{ accountKey?: unknown; gameId?: unknown; row?: unknown } | null>) {
    const row = record?.row as Partial<CorpusRow> | null | undefined;
    const valid = record?.accountKey === accountKey && Boolean(row) && typeof row === "object"
      && typeof row?.gameId === "string" && row.gameId === record.gameId;
    if (!valid) return null;
    rows.push(row as T);
  }
  return rows;
}
