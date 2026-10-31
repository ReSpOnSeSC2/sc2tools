/**
 * Clearing the game history this browser keeps on the device. It loads on demand, never in a page's first load: the
 * guard every signed-in page mounts imports it only when it has something to clear
 * (components/chrome/DeviceHistoryGuard), and Delete history, restore, account deletion and the sync are chunks of
 * their own. Every clear also moves a clear mark, so a sync that started before the clear, in this tab or another,
 * writes nothing after it.
 *
 * Example:
 *   forgetDeviceCopy(); // after Delete history succeeds
 */
import { DEVICE_CLEAR_KEY, DEVICE_CORPUS_DB_NAME, DEVICE_DELETE_OWED_KEY, DEVICE_NOTE_KEY } from "./deviceKeys";

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
 * Remove this browser's copy of the analysis corpus: forget the note, queue the database's delete, then move the clear
 * mark, each step in its own try. Other tabs' connections step aside on versionchange, and the delete finishes once
 * they have; nothing waits for it. Until it is seen to finish, the delete is recorded as owed, so the guard issues it
 * again on a later page if it never does (a frozen tab held it, or the browser closed first).
 *
 * Example:
 *   forgetDeviceCopy(); // after Delete history succeeds
 */
export function forgetDeviceCopy(factory: IDBFactory | undefined = globalIndexedDb()): void {
  const mark = `${Date.now()}.${Math.random().toString(36).slice(2)}`;
  try {
    window.localStorage.removeItem(DEVICE_NOTE_KEY);
  } catch {
    // Storage is refused: there is no note to forget, and the sync keeps no copy without one.
  }
  // Queued before the mark moves, so a sync that reads the new mark opens after the delete.
  const queued = queueDelete(factory, mark);
  try {
    window.localStorage.setItem(DEVICE_CLEAR_KEY, mark);
  } catch {
    // Storage is refused or full: the note is already gone, and the queued delete still removes the copy.
  }
  try {
    if (queued) window.localStorage.setItem(DEVICE_DELETE_OWED_KEY, mark);
  } catch {
    // Storage is full: the delete still runs; only issuing it again, should it never finish, is given up.
  }
}

/**
 * Record that the delete queued by the clear that set `mark` is done: it finished, or an open queued after it has
 * succeeded. A newer clear's owed delete stays owed.
 *
 * Example:
 *   settleDelete(markReadBeforeThisOpen);
 */
export function settleDelete(mark: string | null): void {
  try {
    if (mark !== null && window.localStorage.getItem(DEVICE_DELETE_OWED_KEY) === mark) {
      window.localStorage.removeItem(DEVICE_DELETE_OWED_KEY);
    }
  } catch {
    // Storage is refused: nothing was recorded as owed.
  }
}

/**
 * Whether a wipe, restore or account deletion that failed may have gone through anyway, so the copy here must go: true
 * unless the server rejected it outright (a 4xx). A lost answer, a timeout or a server error (5xx) can all follow a
 * request that went through, and being offline when the failure arrives does not show the request never left.
 *
 * Example:
 *   catch (error) { if (mayHaveApplied(error)) forgetDeviceCopy(); }
 */
export function mayHaveApplied(error: unknown): boolean {
  const status = (error as { status?: unknown } | null | undefined)?.status;
  return !(typeof status === "number" && status >= 400 && status < 500);
}

/** Queue the database's delete; once it succeeds, `mark`'s clear owes nothing. False when IndexedDB refuses it. */
function queueDelete(factory: IDBFactory | undefined, mark: string): boolean {
  try {
    const request = factory?.deleteDatabase(DEVICE_CORPUS_DB_NAME);
    if (!request) return false;
    // A delete that fails stays owed, so the guard issues it again.
    request.onerror = (event) => event.preventDefault();
    request.onsuccess = () => settleDelete(mark);
    return true;
  } catch {
    // IndexedDB is refused for this document: there is nothing to delete.
    return false;
  }
}

function globalIndexedDb(): IDBFactory | undefined {
  try {
    return globalThis.indexedDB;
  } catch {
    return undefined;
  }
}
