/**
 * A localStorage note naming the account whose game history this browser keeps on the device. It lets the analysis
 * corpus provider decide at once, without loading the device store or touching IndexedDB, that an account has no
 * device copy, so those accounts load exactly as before. It is only a hint: IndexedDB stays the source of truth, a
 * note that names a missing copy costs one probe, and the sync corrects the note when it learns otherwise.
 *
 * Clearing the copy (sign-out, another account, Delete history, restore, account deletion) also moves a clear mark,
 * so a sync that started before the clear, in this tab or another, writes nothing after it.
 *
 * Example:
 *   if (mayHaveDeviceCopy(accountKey)) await import("./analysisCorpusSync");
 */
import { DEVICE_CLEAR_KEY, DEVICE_CORPUS_DB_NAME, DEVICE_NOTE_KEY } from "./deviceKeys";

/** True when this account may keep a copy here, or when the note cannot be read (then only a probe can tell). */
export function mayHaveDeviceCopy(accountKey: string): boolean {
  try {
    return window.localStorage.getItem(DEVICE_NOTE_KEY) === accountKey;
  } catch {
    return true;
  }
}

/**
 * Name the account this browser keeps history for, or forget it with null. Returns false when a named account still
 * would not be probed: the write was refused while reads work (storage full), so the copy could never be found.
 *
 * Example:
 *   if (!noteDeviceCopy(accountKey)) dropTheCopy();
 */
export function noteDeviceCopy(accountKey: string | null): boolean {
  try {
    if (accountKey) window.localStorage.setItem(DEVICE_NOTE_KEY, accountKey);
    else window.localStorage.removeItem(DEVICE_NOTE_KEY);
  } catch {
    // A refused write is harmless while reads are refused too: then the provider always probes.
  }
  return accountKey === null || mayHaveDeviceCopy(accountKey);
}

/**
 * The current clear mark. A sync reads it when it starts and writes nothing once it has moved.
 *
 * Example:
 *   const mark = deviceClearMark();
 *   // ...later, before a write:
 *   if (deviceClearMark() !== mark) return;
 */
export function deviceClearMark(): string | null {
  try {
    return window.localStorage.getItem(DEVICE_CLEAR_KEY);
  } catch {
    return null;
  }
}

/**
 * Remove this browser's copy of the analysis corpus: move the clear mark, forget the note and delete the database.
 * Other tabs' connections step aside on versionchange, and the delete finishes once they have; nothing waits for it.
 *
 * Example:
 *   forgetDeviceCopy(); // after Delete history succeeds
 */
export function forgetDeviceCopy(factory: IDBFactory | undefined = globalIndexedDb()): void {
  try {
    window.localStorage.setItem(DEVICE_CLEAR_KEY, `${Date.now()}.${Math.random().toString(36).slice(2)}`);
    window.localStorage.removeItem(DEVICE_NOTE_KEY);
  } catch {
    // Storage is refused: there is no note to forget, and a sync cannot have noted a copy either.
  }
  try {
    const request = factory?.deleteDatabase(DEVICE_CORPUS_DB_NAME);
    if (request) request.onerror = (event) => event.preventDefault();
  } catch {
    // IndexedDB is refused for this document: there is nothing to delete.
  }
}

function globalIndexedDb(): IDBFactory | undefined {
  try {
    return globalThis.indexedDB;
  } catch {
    return undefined;
  }
}
