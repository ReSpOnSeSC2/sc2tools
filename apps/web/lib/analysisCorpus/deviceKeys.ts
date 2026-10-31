/**
 * Storage names for the analysis corpus kept on this device. Kept apart so the guard every signed-in page loads
 * (components/chrome/DeviceHistoryGuard) can read the note without bundling the device store or the note helpers.
 */

/** The IndexedDB database holding the device copy (lib/analysisCorpus/deviceStore). */
export const DEVICE_CORPUS_DB_NAME = "sc2tools-analysis-corpus";

/** The localStorage note naming the account whose history this browser keeps (lib/analysisCorpus/deviceNote). */
export const DEVICE_NOTE_KEY = "sc2tools.analysisCorpus.deviceAccount";

/** A localStorage mark that every clear moves, so a sync that started before it (in any tab) writes nothing after it. */
export const DEVICE_CLEAR_KEY = "sc2tools.analysisCorpus.clearMark";
