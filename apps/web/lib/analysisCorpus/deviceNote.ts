/**
 * A localStorage note naming the account whose game history this browser keeps on the device. It lets the analysis
 * corpus provider decide at once, without loading the device store or touching IndexedDB, that an account has no
 * device copy, so those accounts load exactly as before. It is only a hint: IndexedDB stays the source of truth, a
 * note that names a missing copy costs one probe, and the sync corrects the note when it learns otherwise.
 *
 * Example:
 *   if (mayHaveDeviceCopy(accountKey)) await import("./analysisCorpusSync");
 */

const DEVICE_NOTE_KEY = "sc2tools.analysisCorpus.deviceAccount";

/** True when this account may keep a copy here, or when the note cannot be read (then only a probe can tell). */
export function mayHaveDeviceCopy(accountKey: string): boolean {
  try {
    return window.localStorage.getItem(DEVICE_NOTE_KEY) === accountKey;
  } catch {
    return true;
  }
}

/**
 * Name the account this browser keeps history for, or forget it with null.
 *
 * Example:
 *   noteDeviceCopy(accountKey);
 */
export function noteDeviceCopy(accountKey: string | null): void {
  try {
    if (accountKey) window.localStorage.setItem(DEVICE_NOTE_KEY, accountKey);
    else window.localStorage.removeItem(DEVICE_NOTE_KEY);
  } catch {
    // Storage is refused: the provider probes instead.
  }
}
