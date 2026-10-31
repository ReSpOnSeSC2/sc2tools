/**
 * A localStorage note naming the account whose game history this browser keeps on the device. It lets the analysis
 * corpus provider decide at once, without loading the device store or touching IndexedDB, that an account has no
 * device copy, so those accounts load exactly as before. IndexedDB stays the source of truth: a note that names a
 * missing copy costs one probe, after which the sync clears it. The reverse never holds: a copy is kept only while the
 * note names it, since the note is how a sign-out or another account finds the copy to clear it
 * (components/chrome/DeviceHistoryGuard). So the note only goes in a full clear (./deviceClear, loaded on demand),
 * which moves the clear mark too.
 *
 * Example:
 *   if (mayHaveDeviceCopy(accountKey)) await import("./analysisCorpusSync");
 */
import { DEVICE_NOTE_KEY } from "./deviceKeys";

/** The account the note names, null when it names none, or undefined when storage refuses the read. */
export function deviceNote(): string | null | undefined {
  try {
    return window.localStorage.getItem(DEVICE_NOTE_KEY);
  } catch {
    return undefined;
  }
}

/** True when this account may keep a copy here, or when the note cannot be read (then only a probe can tell). */
export function mayHaveDeviceCopy(accountKey: string): boolean {
  const noted = deviceNote();
  return noted === undefined || noted === accountKey;
}

/**
 * Name the account this browser keeps history for, or forget it with null. True only when the note reads back as
 * asked, so a refused write (storage full) or a note that cannot be read fails closed and no copy is kept on its word.
 *
 * Example:
 *   if (!noteDeviceCopy(accountKey)) keepInMemory();
 */
export function noteDeviceCopy(accountKey: string | null): boolean {
  try {
    if (accountKey) window.localStorage.setItem(DEVICE_NOTE_KEY, accountKey);
    else window.localStorage.removeItem(DEVICE_NOTE_KEY);
  } catch {
    // A refused write still stands when the note already reads as asked (storage full, the same account).
  }
  return deviceNote() === accountKey;
}
