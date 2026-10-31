/**
 * Clearing the game history this browser keeps on the device. It loads on demand, never in a page's first load: the
 * guard every signed-in page mounts imports it only when the note names a copy that is not the signed-in account's
 * (components/chrome/DeviceHistoryGuard), and Delete history, restore, account deletion and the sync are chunks of
 * their own. Every clear also moves a clear mark, so a sync that started before the clear, in this tab or another,
 * writes nothing after it.
 *
 * Example:
 *   forgetDeviceCopy(); // after Delete history succeeds
 */
import { DEVICE_CLEAR_KEY, DEVICE_CORPUS_DB_NAME, DEVICE_NOTE_KEY } from "./deviceKeys";

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
 * Remove this browser's copy of the analysis corpus: forget the note, move the clear mark and delete the database.
 * Other tabs' connections step aside on versionchange, and the delete finishes once they have; nothing waits for it.
 *
 * Example:
 *   forgetDeviceCopy(); // after Delete history succeeds
 */
export function forgetDeviceCopy(factory: IDBFactory | undefined = globalIndexedDb()): void {
  try {
    window.localStorage.removeItem(DEVICE_NOTE_KEY);
  } catch {
    // Storage is refused: there is no note to forget, and the sync keeps no copy without one.
  }
  try {
    window.localStorage.setItem(DEVICE_CLEAR_KEY, `${Date.now()}.${Math.random().toString(36).slice(2)}`);
  } catch {
    // Storage is refused or full: the note is already gone, and the delete below still removes the copy.
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
