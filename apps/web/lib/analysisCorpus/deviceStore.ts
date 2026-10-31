/**
 * Game history kept on this device for the analysis corpus that Daily Pulse, Season Recap and Arcade read. It is an
 * IndexedDB database of its own, apart from Instant Analysis, and it holds one account at a time:
 *
 *   accounts: keyPath `accountKey`, holding the stored corpus's version, watermark and row count
 *   games:    keyPath [`accountKey`, `gameId`], index `accountKey`, holding one strict analysis row each
 *
 * A snapshot replaces everything in one transaction, so another account's history never stays beside it. A delta
 * merges its rows and moves the watermark in one transaction, and only while the stored marks are still the ones it
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
const ACCOUNTS = "accounts";
const GAMES = "games";
const BY_ACCOUNT = "accountKey";

export type DeviceCorpus<T extends CorpusRow> =
  | { kind: "absent" }
  | { kind: "unreadable" }
  | { kind: "stored"; marks: CorpusMarks; rows: T[] };

type AccountRecord = CorpusMarks & { accountKey: string; count: number; savedAt: string; schema: number };

/**
 * Open the device corpus, or resolve null when IndexedDB is missing or refused. With `create: false` it only probes,
 * and resolves null without creating anything when nothing was ever stored.
 *
 * Example:
 *   const db = await openDeviceCorpus(defaultIndexedDb(), { create: true });
 */
export function openDeviceCorpus(
  factory: IDBFactory | undefined,
  { create }: { create: boolean },
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
    let absent = false;
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
      resolve(db);
    };
    request.onerror = (event) => {
      event.preventDefault();
      if (absent) resolve(null);
      else reject(request.error ?? new Error("device corpus open failed"));
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
  return { kind: "stored", marks: { corpusVersion: account.corpusVersion, watermark: account.watermark }, rows };
}

/**
 * Replace everything on this device with one account's snapshot and its marks, in one transaction.
 *
 * Example:
 *   await saveDeviceSnapshot(db, accountKey, items, { corpusVersion: 0, watermark }, 20_000);
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
        const account = accountRecord(current.result, accountKey);
        if (!account || account.corpusVersion !== from.corpusVersion || account.watermark !== from.watermark) return;
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

/**
 * Remove every stored row and account in one transaction, keeping the empty database.
 *
 * Example:
 *   await clearDeviceCorpus(db);
 */
export function clearDeviceCorpus(db: IDBDatabase): Promise<void> {
  return idbTransactionOn(db, [ACCOUNTS, GAMES], "readwrite", (tx) => {
    tx.objectStore(ACCOUNTS).clear();
    tx.objectStore(GAMES).clear();
  });
}

function createSchema(db: IDBDatabase): void {
  if (!db.objectStoreNames.contains(ACCOUNTS)) db.createObjectStore(ACCOUNTS, { keyPath: "accountKey" });
  if (!db.objectStoreNames.contains(GAMES)) {
    db.createObjectStore(GAMES, { keyPath: ["accountKey", "gameId"] }).createIndex(BY_ACCOUNT, "accountKey");
  }
}

function accountRecordFor(accountKey: string, marks: CorpusMarks, count: number): AccountRecord {
  return {
    accountKey,
    corpusVersion: marks.corpusVersion,
    watermark: marks.watermark,
    count,
    savedAt: new Date().toISOString(),
    schema: DEVICE_CORPUS_SCHEMA,
  };
}

function accountRecord(value: unknown, accountKey: string): AccountRecord | null {
  if (!value || typeof value !== "object") return null;
  const record = value as Partial<AccountRecord>;
  const marksOk = Number.isSafeInteger(record.corpusVersion) && (record.corpusVersion as number) >= 0
    && typeof record.watermark === "string" && !Number.isNaN(Date.parse(record.watermark));
  const countOk = Number.isSafeInteger(record.count) && (record.count as number) >= 0;
  return record.accountKey === accountKey && record.schema === DEVICE_CORPUS_SCHEMA && marksOk && countOk
    ? (record as AccountRecord)
    : null;
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
