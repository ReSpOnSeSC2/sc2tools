import {
  mergeCorpusChanges,
  newestFirst,
  readCorpusChanges,
  snapshotMarks,
  type CorpusMarks,
} from "@/lib/analysisCorpus/changes";
import {
  clearDeviceCorpus,
  mergeDeviceDelta,
  openDeviceCorpus,
  readDeviceCorpus,
  saveDeviceSnapshot,
  type DeviceCorpus,
} from "@/lib/analysisCorpus/deviceStore";
import { defaultIndexedDb } from "@/lib/instant/idb";
import type { AnalysisApiGame, AnalysisGamesPage } from "./useAnalysisGames";

/**
 * One sync of the signed-in account's analysis corpus, loaded on demand by
 * AnalysisGamesProvider so none of it adds to the dashboard's first load.
 *
 * With no device copy (nothing stored for this account, and no request to
 * keep one) this is the plain snapshot read it always was. With one, the
 * stored rows show first, a changed-since read brings them up to date, and
 * the rows and new marks are written back in one transaction. Whatever only a
 * snapshot can resolve falls back to one, which then replaces the device copy.
 * Device storage is best effort: when IndexedDB is missing, refused or full,
 * the corpus still loads, in memory only.
 */

/** One full snapshot read, with the marks its first page carried (null from a server that sends none). */
export type CorpusSnapshot = {
  items: AnalysisApiGame[];
  pagesFetched: number;
  hitCorpusLimit: boolean;
  marks: CorpusMarks | null;
};

/** The corpus one sync produced, and whether this account's copy is kept on this device. */
export type CorpusSync = CorpusSnapshot & { onDevice: boolean };

type StoredCorpus = CorpusSync & { marks: CorpusMarks };

export type CorpusSyncInput = {
  accountKey: string;
  /** The account asked to keep its history on this device (the one-time history gate). */
  keepOnDevice: boolean;
  fetchPage: (path: string) => Promise<unknown>;
  /** The snapshot page URL after `previousPage`, or null when the snapshot is complete. */
  pageKey: (pageIndex: number, previousPage: AnalysisGamesPage | null) => string | null;
  /** Called with the stored copy before it is brought up to date, so it can show at once. */
  onStored: (stored: CorpusSync) => void;
  maxRows: number;
  pageSize: number;
  maxPages: number;
};

const UNREADABLE: DeviceCorpus<AnalysisApiGame> = { kind: "unreadable" };

/**
 * Example:
 *   const synced = await syncAnalysisCorpus({ accountKey, keepOnDevice: false, fetchPage, pageKey, onStored,
 *     maxRows: 20_000, pageSize: 2000, maxPages: 10 });
 */
export async function syncAnalysisCorpus(input: CorpusSyncInput): Promise<CorpusSync> {
  const device = await openDevice(input);
  try {
    if (device?.stored) {
      input.onStored(device.stored);
      const updated = await applyChanges(device.db, device.stored, input);
      if (updated) return updated;
    }
    const snapshot = await readSnapshot(input);
    const onDevice = device ? await storeSnapshot(device.db, snapshot, input) : false;
    return { ...snapshot, onDevice };
  } finally {
    device?.db.close();
  }
}

/**
 * Read the bounded snapshot newest first, page by page, up to the corpus
 * ceiling. The first page's corpus version and watermark come back too.
 */
async function readSnapshot(input: CorpusSyncInput): Promise<CorpusSnapshot> {
  const items: AnalysisApiGame[] = [];
  let previousPage: AnalysisGamesPage | null = null;
  let pagesFetched = 0;
  let hitCorpusLimit = false;
  let marks: CorpusMarks | null = null;

  for (let pageIndex = 0; pageIndex < input.maxPages; pageIndex += 1) {
    const path = input.pageKey(pageIndex, previousPage);
    if (!path) break;
    const page = (await input.fetchPage(path)) as AnalysisGamesPage;
    if (pageIndex === 0) marks = snapshotMarks(page);
    const pageItems = Array.isArray(page?.items) ? page.items : [];
    const remaining = input.maxRows - items.length;
    items.push(...pageItems.slice(0, remaining));
    pagesFetched += 1;
    previousPage = page;

    if (items.length >= input.maxRows) {
      hitCorpusLimit = pageItems.length > remaining || Boolean(page.nextCursor);
      break;
    }
    if (!page.nextCursor) break;
    if (pageIndex === input.maxPages - 1) hitCorpusLimit = true;
  }
  return { items, pagesFetched, hitCorpusLimit, marks };
}

/** The device copy this sync uses, or null when it stays in memory. */
async function openDevice(
  input: CorpusSyncInput,
): Promise<{ db: IDBDatabase; stored: StoredCorpus | null } | null> {
  const db = await openDeviceCorpus(defaultIndexedDb(), { create: input.keepOnDevice }).catch(() => null);
  if (!db) return null;
  const stored = await readDeviceCorpus<AnalysisApiGame>(db, input.accountKey, input.maxRows)
    .catch(() => UNREADABLE);
  if (stored.kind === "absent" && !input.keepOnDevice) {
    // Nothing kept for this account, and it has not asked to keep any: memory only, as before.
    db.close();
    return null;
  }
  if (stored.kind !== "stored") return { db, stored: null };
  const items = newestFirst(stored.rows);
  return { db, stored: { items, pagesFetched: 0, hitCorpusLimit: false, marks: stored.marks, onDevice: true } };
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
  // Best effort: when another tab moved the copy first, or the write fails, this tab still shows its merged corpus.
  await mergeDeviceDelta(db, input.accountKey, stored.marks, delta.changes, delta.marks, input.maxRows)
    .catch(() => false);
  return { items, pagesFetched: delta.pages, hitCorpusLimit: false, marks: delta.marks, onDevice: true };
}

async function storeSnapshot(
  db: IDBDatabase,
  snapshot: CorpusSnapshot,
  input: CorpusSyncInput,
): Promise<boolean> {
  if (snapshot.hitCorpusLimit) {
    // Past the ceiling a copy could not be brought up to date exactly, so none is kept.
    await clearDeviceCorpus(db).catch(() => undefined);
    return false;
  }
  // A server from before changed-since reads sends no marks; the stored copy and its own marks stay valid.
  if (!snapshot.marks) return false;
  return saveDeviceSnapshot(db, input.accountKey, snapshot.items, snapshot.marks, input.maxRows)
    .then(() => true, () => false);
}
