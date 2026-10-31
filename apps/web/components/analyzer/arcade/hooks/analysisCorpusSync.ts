import {
  mergeCorpusChanges,
  newestFirst,
  readCorpusChanges,
  snapshotMarks,
  type CorpusMarks,
} from "@/lib/analysisCorpus/changes";
import {
  deleteDeviceCorpus,
  mergeDeviceDelta,
  openDeviceCorpus,
  readDeviceCorpus,
  resetDeviceCorpus,
  saveDeviceSnapshot,
} from "@/lib/analysisCorpus/deviceStore";
import { mayHaveDeviceCopy, noteDeviceCopy } from "@/lib/analysisCorpus/deviceNote";
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
 * full, the corpus still loads, in memory only. Nothing is written to the
 * device once the caller's run is cancelled.
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
  const device = await openDevice(input);
  // A copy that may be out of date, and that could not be dropped, is left on the device.
  let stale = false;
  try {
    if (device?.stored) {
      input.onStored(device.stored);
      const updated = await applyChanges(device.db, device.stored, input);
      if (updated) return updated;
      input.signal.throwIfAborted();
      stale = !(await dropCopy(device.db, input.accountKey));
    }
    const snapshot = checkedSnapshot(await input.readSnapshot());
    if (!device) return { ...snapshot, onDevice: false, kept: false };
    input.onSnapshot(snapshot);
    input.signal.throwIfAborted();
    // The store replaces or drops whatever copy was there, so its outcome alone decides what is left.
    const stored = await storeSnapshot(device.db, snapshot, input);
    stale = stored === "stale";
    return { ...snapshot, onDevice: stored === "saved", kept: stored !== "stale" };
  } finally {
    device?.db.close();
    if (stale) {
      deleteDeviceCorpus(defaultIndexedDb());
      noteDeviceCopy(null);
    }
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

/** The device copy this sync uses, or null when it stays in memory. */
async function openDevice(
  input: CorpusSyncInput,
): Promise<{ db: IDBDatabase; stored: StoredCorpus | null } | null> {
  // A note naming an account whose database is gone is forgotten, so its later loads skip the device again.
  const forget = () => { if (mayHaveDeviceCopy(input.accountKey)) noteDeviceCopy(null); };
  const db = await openDeviceCorpus(defaultIndexedDb(), { create: input.keepOnDevice, onAbsent: forget }).catch(() => null);
  if (!db) return null;
  // A read that fails says nothing about whose copy is here, so only an account that asked to keep one replaces it.
  const stored = await readDeviceCorpus<AnalysisApiGame>(db, input.accountKey, input.maxRows).catch(() => null);
  if ((stored === null || stored.kind === "absent") && !input.keepOnDevice) {
    // Nothing kept for this account, and it has not asked to keep any: memory only, as before.
    if (stored?.kind === "absent") forget();
    db.close();
    return null;
  }
  if (stored?.kind === "stored" || stored?.kind === "kept") noteDeviceCopy(input.accountKey);
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
): Promise<CorpusSync | null> {
  const delta = await readCorpusChanges<AnalysisApiGame>(input.fetchPage, stored.marks, {
    limit: input.pageSize,
    maxPages: input.maxPages,
  });
  if (!delta) return null;
  const items = mergeCorpusChanges(stored.items, delta.changes);
  if (items.length > input.maxRows) return null;
  input.signal.throwIfAborted();
  // Best effort: when another tab moved the copy first, or the write fails, this tab still shows its merged corpus.
  await mergeDeviceDelta(db, input.accountKey, stored.marks, delta.changes, delta.marks, input.maxRows)
    .catch(() => false);
  return { items, pagesFetched: delta.pages, hitCorpusLimit: false, marks: delta.marks, onDevice: true, kept: true };
}

/** "saved"; "dropped" (no usable copy, the account's choice kept); or "stale" (neither worked). */
async function storeSnapshot(
  db: IDBDatabase,
  snapshot: CorpusSnapshot,
  input: CorpusSyncInput,
): Promise<"saved" | "dropped" | "stale"> {
  // Past the ceiling, or without marks (a server from before changed-since reads, or pages from two epochs), a copy
  // could not be brought up to date exactly. A save that fails (storage full) rolls back to the copy it replaced.
  const saved = !snapshot.hitCorpusLimit && snapshot.marks !== null
    && await saveDeviceSnapshot(db, input.accountKey, snapshot.items, snapshot.marks, input.maxRows)
      .then(() => true, () => false);
  if (!saved) input.signal.throwIfAborted();
  const outcome = saved ? "saved" : (await dropCopy(db, input.accountKey)) ? "dropped" : "stale";
  // The device now records this account's choice, with or without a usable copy. A choice this browser cannot note
  // would never be found again, so that copy goes rather than stay orphaned.
  return outcome === "stale" || noteDeviceCopy(input.accountKey) ? outcome : "stale";
}

function dropCopy(db: IDBDatabase, accountKey: string): Promise<boolean> {
  return resetDeviceCorpus(db, accountKey).then(() => true, () => false);
}
