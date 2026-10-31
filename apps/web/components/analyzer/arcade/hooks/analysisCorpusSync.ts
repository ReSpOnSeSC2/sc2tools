import {
  mergeCorpusChanges,
  newestFirst,
  readCorpusChanges,
  snapshotMarks,
  type CorpusMarks,
} from "@/lib/analysisCorpus/changes";
import {
  mergeDeviceDelta,
  openDeviceCorpus,
  readDeviceCorpus,
  resetDeviceCorpus,
  saveDeviceSnapshot,
} from "@/lib/analysisCorpus/deviceStore";
import { deviceClearMark, forgetDeviceCopy, settleDelete } from "@/lib/analysisCorpus/deviceClear";
import { deviceNote, mayHaveDeviceCopy, noteDeviceCopy } from "@/lib/analysisCorpus/deviceNote";
import { defaultIndexedDb } from "@/lib/instant/idb";
import type { AnalysisApiGame, RawAnalysisSnapshot } from "./useAnalysisGames";

/**
 * One sync of the signed-in account's analysis corpus, loaded on demand by
 * AnalysisGamesProvider so none of it adds to the dashboard's first load.
 *
 * With no device copy (nothing stored for this account, and no request to
 * keep one) this is the plain snapshot read it always was. With one, the
 * stored rows show first, a changed-since read brings them up to date, and
 * the rows and new marks are written back in one transaction. Whatever only a
 * snapshot can resolve falls back to one, which then replaces the device copy.
 * A copy that needs a snapshot is dropped before the snapshot is read, keeping
 * the account's choice, so it never shows again even if the snapshot fails;
 * a copy that can be neither replaced nor dropped goes with its database.
 * Device storage is best effort: when IndexedDB is missing, refused, slow or
 * full, the corpus still loads, in memory only.
 *
 * A copy exists only under a note naming its account, since the note is how a
 * sign-out or another account finds the copy to clear it. A first keep clears
 * any copy not noted for this account, then notes the account before creating
 * anything; a browser that cannot keep the note keeps no copy at all; and the
 * note only ever goes in a full clear, which also moves the clear mark, so a
 * keep running in another tab stops rather than finish under no note.
 * Nothing is written to the device once the caller's run is cancelled, or once
 * anything cleared the copy (sign-out, another account, Delete history) after
 * this sync started; a sync that sees such a clear reads the corpus again, in
 * memory only, since what it read before the clear may be out of date.
 */

/** One full snapshot read, with its checked marks (null when the server sent none, or pages disagreed). */
export type CorpusSnapshot = {
  items: AnalysisApiGame[];
  pagesFetched: number;
  hitCorpusLimit: boolean;
  marks: CorpusMarks | null;
};

/** The corpus one sync produced. */
export type CorpusSync = CorpusSnapshot & {
  /** The corpus shown is the copy stored on this device. */
  onDevice: boolean;
  /** This device records the account's choice to keep its history here (with or without a usable copy). */
  kept: boolean;
};

type StoredCorpus = CorpusSync & { marks: CorpusMarks };

/** Throws before a device write once the run is cancelled, or with DeviceCleared once the copy is no longer this sync's. */
type WriteGuard = () => void;

/** One sync's hold on the device: the clear mark it began with, its write guard, and whether the copy is still its own. */
type SyncRun = { mark: string | null; current: WriteGuard; owns: () => boolean };

/**
 * The copy is no longer this sync's: a clear moved the mark (the copy is being deleted, and what was read may be out of
 * date), or another account's keep took the note.
 */
class DeviceCleared extends Error {}

export type CorpusSyncInput = {
  accountKey: string;
  /** The account asked to keep its history on this device (the one-time history gate). */
  keepOnDevice: boolean;
  fetchPage: (path: string) => Promise<unknown>;
  readSnapshot: () => Promise<RawAnalysisSnapshot>;
  /** Called with the stored copy before it is brought up to date, so it can show at once. */
  onStored: (stored: CorpusSync) => void;
  /** Called with a fetched snapshot before it is stored, so it shows without waiting on the save. */
  onSnapshot: (snapshot: CorpusSnapshot) => void;
  /** The caller's run; once it is aborted, nothing more is written to the device. */
  signal: AbortSignal;
  maxRows: number;
  pageSize: number;
  maxPages: number;
};

/**
 * Example:
 *   const synced = await syncAnalysisCorpus({ accountKey, keepOnDevice: false, fetchPage, readSnapshot, onStored,
 *     onSnapshot, signal, maxRows: 20_000, pageSize: 2000, maxPages: 10 });
 */
export async function syncAnalysisCorpus(input: CorpusSyncInput): Promise<CorpusSync> {
  const noted = deviceNote();
  // Without a note it can read, nothing could find this browser's copy after a sign-out: whatever is here goes.
  if (noted === undefined) {
    forgetDeviceCopy(defaultIndexedDb());
    return memoryOnly(await input.readSnapshot());
  }
  // A first keep clears any copy not noted for this account, so no other account's rows ever sit under its note.
  if (input.keepOnDevice && noted !== input.accountKey) forgetDeviceCopy(defaultIndexedDb());
  const mark = deviceClearMark();
  // The copy stays this sync's while nothing has cleared it and no other account's keep has taken the note.
  const owns = () => deviceClearMark() === mark && deviceNote() === input.accountKey;
  const current: WriteGuard = () => {
    input.signal.throwIfAborted();
    if (!owns()) throw new DeviceCleared();
  };
  try {
    return await syncWithDevice(input, { mark, current, owns });
  } catch (error) {
    // A clear that stopped this sync (or came before its cancellation) may have run before its open recreated the
    // database, leaving the account's record there with no note: it goes too.
    if (deviceNote() === null) forgetDeviceCopy(defaultIndexedDb());
    if (!(error instanceof DeviceCleared)) throw error;
    // What this sync read before the clear (Delete history or restore in another tab) may be out of date.
    return memoryOnly(await input.readSnapshot());
  }
}

async function syncWithDevice(input: CorpusSyncInput, run: SyncRun): Promise<CorpusSync> {
  const { current } = run;
  const device = await openDevice(input, run);
  // A copy that may be out of date, and that could not be dropped, is left on the device.
  let stale = false;
  try {
    // Nothing of a copy cleared while it opened is shown or written.
    if (device) current();
    if (device?.stored) {
      input.onStored(device.stored);
      const updated = await applyChanges(device.db, device.stored, input, current);
      if (updated) return updated;
      current();
      stale = !(await dropCopy(device.db, input.accountKey));
    } else if (device && input.keepOnDevice) {
      // A keep holding no usable copy of its own drops whatever is there first, so another account's rows cannot
      // outlive a delete that failed under this account's note.
      current();
      stale = !(await dropCopy(device.db, input.accountKey));
    }
    const snapshot = checkedSnapshot(await input.readSnapshot());
    if (!device) return { ...snapshot, onDevice: false, kept: false };
    current();
    input.onSnapshot(snapshot);
    // The store replaces or drops whatever copy was there, so its outcome alone decides what is left.
    const stored = await storeSnapshot(device.db, snapshot, input, current);
    stale = stored === "stale";
    return { ...snapshot, onDevice: stored === "saved", kept: stored !== "stale" };
  } finally {
    device?.db.close();
    // A copy no longer this sync's was deleted by whatever moved the mark or took the note, and may be a newer keep.
    if (stale && run.owns()) forgetDeviceCopy(defaultIndexedDb());
  }
}

/** Marks from the first page, kept only when every fetched page came from the same corpus epoch. */
function checkedSnapshot(raw: RawAnalysisSnapshot): CorpusSnapshot {
  const marks = snapshotMarks(raw.firstPage);
  // Pages served under another epoch (a deploy that changed the corpus rules) cannot be kept as one copy.
  const oneEpoch = marks !== null && raw.pageEpochs.length === raw.pagesFetched
    && raw.pageEpochs.every((epoch) => epoch === marks.corpusEpoch);
  return { items: raw.items, pagesFetched: raw.pagesFetched, hitCorpusLimit: raw.hitCorpusLimit, marks: oneEpoch ? marks : null };
}

/** A corpus read in memory only, when this browser cannot keep a copy or one was cleared mid-sync. */
function memoryOnly(raw: RawAnalysisSnapshot): CorpusSync {
  return { ...checkedSnapshot(raw), onDevice: false, kept: false };
}

/** True while this sync may still act on the device: its run goes on, and the copy is still its own (see current). */
function stillCurrent(current: WriteGuard): boolean {
  try {
    current();
    return true;
  } catch {
    return false;
  }
}

/** The device copy this sync uses, or null when it stays in memory. */
async function openDevice(
  input: CorpusSyncInput,
  { mark, current }: SyncRun,
): Promise<{ db: IDBDatabase; stored: StoredCorpus | null } | null> {
  const factory = defaultIndexedDb();
  if (!factory) return null;
  // An account asking to keep its history is noted before anything is created, so a clear in any tab (sign-out,
  // another account) finds the copy for as long as it can exist. A note that does not hold keeps it in memory.
  const fresh = input.keepOnDevice && !mayHaveDeviceCopy(input.accountKey);
  if (input.keepOnDevice && !noteDeviceCopy(input.accountKey)) return null;
  // A note naming this account's missing copy goes in a full clear, which moves the mark, so nothing can go on writing
  // under a note that is gone. A sync that is no longer current leaves the note alone: a newer keep may have written it.
  const forget = () => {
    if (stillCurrent(current)) forgetDeviceCopy(factory);
  };
  const db = await openDeviceCorpus(factory, { create: input.keepOnDevice, owner: input.accountKey, onAbsent: forget })
    .catch(() => null);
  if (!db) {
    // A keep that cannot open the device takes back the note it just wrote, so later loads skip the probe.
    if (fresh) forget();
    return null;
  }
  // Every delete queued before this open has finished, including one owed since before this sync began.
  settleDelete(mark);
  // A read that fails says nothing about whose copy is here, so only an account that asked to keep one replaces it.
  const stored = await readDeviceCorpus<AnalysisApiGame>(db, input.accountKey, input.maxRows).catch(() => null);
  if ((stored === null || stored.kind === "absent") && !input.keepOnDevice) {
    // Nothing kept for this account, and it has not asked to keep any: memory only, as before.
    if (stored?.kind === "absent") forget();
    db.close();
    return null;
  }
  if (stored?.kind !== "stored") return { db, stored: null };
  const items = newestFirst(stored.rows);
  return {
    db,
    stored: { items, pagesFetched: 0, hitCorpusLimit: false, marks: stored.marks, onDevice: true, kept: true },
  };
}

async function applyChanges(
  db: IDBDatabase,
  stored: StoredCorpus,
  input: CorpusSyncInput,
  current: WriteGuard,
): Promise<CorpusSync | null> {
  const delta = await readCorpusChanges<AnalysisApiGame>(input.fetchPage, stored.marks, {
    limit: input.pageSize,
    maxPages: input.maxPages,
  });
  if (!delta) return null;
  const items = mergeCorpusChanges(stored.items, delta.changes);
  if (items.length > input.maxRows) return null;
  current();
  // Best effort: when another tab moved the copy first, or the write fails, this tab still shows its merged corpus.
  await mergeDeviceDelta(db, input.accountKey, stored.marks, delta.changes, delta.marks, input.maxRows)
    .catch(() => false);
  // A clear while merging can follow a wipe that this delta predates.
  current();
  return { items, pagesFetched: delta.pages, hitCorpusLimit: false, marks: delta.marks, onDevice: true, kept: true };
}

/** "saved"; "dropped" (no usable copy, the account's choice kept); or "stale" (neither worked). */
async function storeSnapshot(
  db: IDBDatabase,
  snapshot: CorpusSnapshot,
  input: CorpusSyncInput,
  current: WriteGuard,
): Promise<"saved" | "dropped" | "stale"> {
  // Past the ceiling, or without marks (a server from before changed-since reads, or pages from two epochs), a copy
  // could not be brought up to date exactly. A save that fails (storage full) rolls back to the copy it replaced.
  const saved = !snapshot.hitCorpusLimit && snapshot.marks !== null
    && await saveDeviceSnapshot(db, input.accountKey, snapshot.items, snapshot.marks, input.maxRows)
      .then(() => true, () => false);
  // The note names this account until a clear removes it, and every clear moves the mark.
  current();
  if (saved) return "saved";
  const dropped = await dropCopy(db, input.accountKey);
  current();
  return dropped ? "dropped" : "stale";
}

function dropCopy(db: IDBDatabase, accountKey: string): Promise<boolean> {
  return resetDeviceCorpus(db, accountKey).then(() => true, () => false);
}
