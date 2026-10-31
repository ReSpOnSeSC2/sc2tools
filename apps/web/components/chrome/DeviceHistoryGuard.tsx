"use client";

import { useEffect } from "react";
import { useAuth } from "@clerk/nextjs";
import {
  DEVICE_CLEAR_KEY,
  DEVICE_CORPUS_DB_NAME,
  DEVICE_DELETE_OWED_KEY,
  DEVICE_NOTE_KEY,
} from "@/lib/analysisCorpus/deviceKeys";

/**
 * Game history this browser keeps on the device belongs to one signed-in account. On every signed-in surface, once
 * Clerk has loaded, a copy noted for another account, or for nobody (signed out), is removed, and so is a copy whose
 * earlier delete never finished. Only localStorage is read here; the clearing code loads on demand, so the guard adds
 * next to nothing to each page's first load.
 */
export function DeviceHistoryGuard() {
  const { isLoaded, isSignedIn, userId } = useAuth();

  useEffect(() => {
    if (!isLoaded) return;
    if (read(DEVICE_NOTE_KEY) === undefined) {
      // No copy is kept while the note cannot be read (the sync deletes what it finds), so one from before goes too.
      deleteDatabase();
      return;
    }
    const owner = isSignedIn && userId ? userId : null;
    if (!mustClear(owner)) return;
    void import("@/lib/analysisCorpus/deviceClear")
      .then(({ forgetDeviceCopy }) => {
        // Another tab may have noted this account's own copy while the clearing code loaded.
        if (mustClear(owner)) forgetDeviceCopy();
      })
      .catch(() => {
        // The clearing code could not load (a deploy replaced it), so the copy goes without it.
        if (mustClear(owner)) clearWithoutModule();
      });
  }, [isLoaded, isSignedIn, userId]);

  return null;
}

/** A localStorage value, or undefined when storage refuses the read. */
function read(key: string): string | null | undefined {
  try {
    return window.localStorage.getItem(key);
  } catch {
    return undefined;
  }
}

/**
 * True when the note names a copy that is not `owner`'s, or when an earlier clear's delete is still owed: it was never
 * seen to finish (a frozen tab held it, or the browser closed first), since any sync that opened the device after it
 * would have settled it.
 */
function mustClear(owner: string | null): boolean {
  if (typeof read(DEVICE_DELETE_OWED_KEY) === "string") return true;
  const noted = read(DEVICE_NOTE_KEY);
  return typeof noted === "string" && noted !== owner;
}

/** The fallback for forgetDeviceCopy (lib/analysisCorpus/deviceClear); a later page settles the delete it owes. */
function clearWithoutModule(): void {
  const mark = `${Date.now()}.${Math.random().toString(36).slice(2)}`;
  try {
    window.localStorage.removeItem(DEVICE_NOTE_KEY);
  } catch {
    // Storage is refused: there is no note to forget.
  }
  const queued = deleteDatabase();
  try {
    window.localStorage.setItem(DEVICE_CLEAR_KEY, mark);
    if (queued) window.localStorage.setItem(DEVICE_DELETE_OWED_KEY, mark);
  } catch {
    // Storage is refused or full; the queued delete still removes the copy.
  }
}

function deleteDatabase(): boolean {
  try {
    return Boolean(globalThis.indexedDB?.deleteDatabase(DEVICE_CORPUS_DB_NAME));
  } catch {
    // IndexedDB is refused for this document: there is nothing to delete.
    return false;
  }
}
