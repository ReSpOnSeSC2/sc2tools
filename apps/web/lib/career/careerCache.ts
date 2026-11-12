import { defaultIndexedDb, idbTransactionOn } from "@/lib/instant/idb";
import { ENGINE_PROTOCOL, INSTANT_ENGINE_VERSION } from "@/lib/instant/engineVersion";
import { isSha256Hex } from "@/lib/instant/integrity";
import { toHeaderResult } from "@/lib/instant/engineOutcome";
import type { KeyedHeader } from "./headerRows";
import { isLadderHeader } from "./headerRows";

const DATABASE = "sc2tools-career";
const STORE = "cache";
const FORMAT = `1/${ENGINE_PROTOCOL}/${INSTANT_ENGINE_VERSION}`;
const OPEN_TIMEOUT_MS = 1500;

export type CachedHeader = KeyedHeader["header"] | null;

export interface CareerCache {
  generation: number;
  rows: Map<string, CachedHeader>;
}

function openCache(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const factory = defaultIndexedDb();
    if (!factory) {
      reject(new Error("Browser storage is unavailable"));
      return;
    }
    const request = factory.open(DATABASE, 1);
    const deadline = setTimeout(() => fail(), OPEN_TIMEOUT_MS);
    let settled = false;

    function fail() {
      settled = true;
      clearTimeout(deadline);
      reject(new Error("Could not open career storage"));
    }

    request.onupgradeneeded = () => request.result.createObjectStore(STORE);
    request.onblocked = request.onerror = fail;
    request.onsuccess = () => {
      clearTimeout(deadline);
      const db = request.result;
      db.onversionchange = () => db.close();
      if (settled) db.close();
      else resolve(db);
    };
  });
}

async function withCareerDatabase<T>(work: (db: IDBDatabase) => Promise<T>): Promise<T> {
  const db = await openCache();
  try {
    return await work(db);
  } finally {
    db.close();
  }
}

function generation(value: unknown): number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : 0;
}

function snapshotRows(value: unknown): unknown[] {
  if (!value || typeof value !== "object" || !("format" in value) || value.format !== FORMAT
    || !("rows" in value) || !Array.isArray(value.rows)) return [];
  return value.rows;
}

function decodeRows(value: unknown): Map<string, CachedHeader> {
  const rows = new Map<string, CachedHeader>();
  for (const record of snapshotRows(value)) {
    if (!Array.isArray(record) || record.length !== 2) continue;
    const [key, entry]: unknown[] = record;
    if (!isSha256Hex(key)) continue;
    if (entry === null) rows.set(key, null);
    else {
      const header = toHeaderResult(entry);
      if (isLadderHeader(header)) rows.set(key, header);
    }
  }
  return rows;
}

export async function readCareerCache(): Promise<CareerCache | null> {
  try {
    return await withCareerDatabase((db) => idbTransactionOn(db, STORE, "readonly", (tx) => {
      const cache: CareerCache = { generation: 0, rows: new Map() };
      const store = tx.objectStore(STORE);
      const epoch = store.get("generation");
      epoch.onsuccess = () => { cache.generation = generation(epoch.result); };
      const snapshot = store.get("snapshot");
      snapshot.onsuccess = () => { cache.rows = decodeRows(snapshot.result); };
      return cache;
    }));
  } catch {
    return null;
  }
}

async function writeSnapshot(db: IDBDatabase, cache: CareerCache, signal?: AbortSignal): Promise<void> {
  let transaction: IDBTransaction | undefined;
  const abort = () => {
    try {
      transaction?.abort();
    } catch {
      // A transaction that has already committed or aborted cannot be rolled back.
    }
  };
  signal?.addEventListener("abort", abort, { once: true });
  try {
    signal?.throwIfAborted();
    await idbTransactionOn(db, STORE, "readwrite", (tx) => {
      transaction = tx;
      const store = tx.objectStore(STORE);
      const request = store.get("generation");
      request.onsuccess = () => {
        if (generation(request.result) !== cache.generation) return;
        try {
          store.put({ format: FORMAT, rows: [...cache.rows] }, "snapshot");
        } catch {
          abort();
        }
      };
    });
  } finally {
    signal?.removeEventListener("abort", abort);
  }
}

/** An overlapping clear invalidates the snapshot even if the scan runs in another tab. */
export async function saveCareerCache(cache: CareerCache, signal?: AbortSignal): Promise<boolean> {
  try {
    await withCareerDatabase((db) => writeSnapshot(db, cache, signal));
    return true;
  } catch {
    return false;
  }
}

export async function clearCareerCache(): Promise<boolean> {
  if (!defaultIndexedDb()) return false;
  try {
    await withCareerDatabase((db) => idbTransactionOn(db, STORE, "readwrite", (tx) => {
      const store = tx.objectStore(STORE);
      const request = store.get("generation");
      request.onsuccess = () => {
        try {
          store.put(generation(request.result) + 1, "generation");
          store.delete("snapshot");
        } catch {
          tx.abort();
        }
      };
    }));
    return true;
  } catch {
    return false;
  }
}
