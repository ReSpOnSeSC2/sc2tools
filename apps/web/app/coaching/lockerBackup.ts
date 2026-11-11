import type { LockerDocument, LockerState } from "./lockerRosterModel";

const BACKUP_DB = "sc2tools-locker-backups";
const BACKUPS = "snapshots";

type Backup = { state: LockerState; savedAt: number; writtenRev?: number };
type Scope = readonly [accountId: string, viewAndRole: string];

function openBackups(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(BACKUP_DB, 1);
    let blocked = false;
    request.onupgradeneeded = () => { request.result.createObjectStore(BACKUPS); };
    request.onerror = () => reject(request.error);
    request.onblocked = () => {
      blocked = true;
      reject(new Error("The Locker backup store is blocked."));
    };
    request.onsuccess = () => {
      const db = request.result;
      if (blocked) { db.close(); return; }
      db.onversionchange = () => db.close();
      resolve(db);
    };
  });
}

async function withBackups<T>(mode: IDBTransactionMode, run: (store: IDBObjectStore, result: (value: T) => void) => void): Promise<T> {
  const db = await openBackups();
  try {
    return await new Promise((resolve, reject) => {
      const tx = db.transaction(BACKUPS, mode);
      let value: T;
      tx.oncomplete = () => resolve(value);
      tx.onabort = () => reject(tx.error ?? new Error("The Locker backup could not be stored."));
      try { run(tx.objectStore(BACKUPS), (out) => { value = out; }); }
      catch (error) { tx.abort(); reject(error); }
    });
  } finally {
    db.close();
  }
}

function backupKey(scope: Scope, rev: number): IDBValidKey {
  return [...scope, rev];
}

/** Complete durable storage before attempting the Locker CAS write. */
export function stageLockerBackup(scope: Scope, doc: LockerDocument): Promise<void> {
  return withBackups("readwrite", (store) => {
    const key = backupKey(scope, doc.rev);
    const current = store.get(key);
    current.onsuccess = () => {
      if (!current.result) store.put({ state: doc.state, savedAt: Date.now() } satisfies Backup, key);
      if (doc.rev >= 2) store.delete(IDBKeyRange.bound(backupKey(scope, 0), backupKey(scope, doc.rev - 2)));
    };
  });
}

/** Only successful writes can make a previous revision eligible for restore. */
export function confirmLockerBackup(scope: Scope, rev: number, writtenRev: number): Promise<void> {
  if (writtenRev !== rev + 1) return Promise.reject(new Error("Unexpected Locker revision."));
  return withBackups("readwrite", (store) => {
    const key = backupKey(scope, rev);
    const request = store.get(key);
    request.onsuccess = () => {
      if (request.result) store.put({ ...request.result, writtenRev }, key);
    };
  });
}

export function loadLockerBackup(scope: Scope, currentRev: number): Promise<Backup | null> {
  if (currentRev < 1) return Promise.resolve(null);
  return withBackups("readonly", (store, result) => {
    const request = store.get(backupKey(scope, currentRev - 1));
    request.onsuccess = () => {
      const backup = request.result as Backup | undefined;
      result(backup?.writtenRev === currentRev && Array.isArray(backup.state?.students) ? backup : null);
    };
  });
}

export function downloadLockerBackup(backup: Backup): void {
  const url = URL.createObjectURL(new Blob([JSON.stringify(backup.state, null, 1)], { type: "application/json" }));
  const link = document.createElement("a");
  link.href = url;
  link.download = "locker-backup-" + new Date(backup.savedAt).toISOString().slice(0, 10) + ".json";
  link.click();
  window.setTimeout(() => URL.revokeObjectURL(url), 1000);
}
