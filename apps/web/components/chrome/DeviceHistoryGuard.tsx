"use client";

import { useEffect } from "react";
import { useAuth } from "@clerk/nextjs";
import { DEVICE_CLEAR_KEY, DEVICE_CORPUS_DB_NAME, DEVICE_NOTE_KEY } from "@/lib/analysisCorpus/deviceKeys";

/**
 * Game history this browser keeps on the device belongs to one signed-in account. On every signed-in surface, once
 * Clerk has loaded, a copy noted for another account, or for nobody (signed out), is removed. Only the note is read
 * here; the clearing code loads on demand, so the guard adds next to nothing to each page's first load.
 */
export function DeviceHistoryGuard() {
  const { isLoaded, isSignedIn, userId } = useAuth();

  useEffect(() => {
    if (!isLoaded) return;
    if (readNote() === undefined) {
      // No copy is kept while the note cannot be read (the sync deletes what it finds), so one from before goes too.
      deleteDatabase();
      return;
    }
    const owner = isSignedIn && userId ? userId : null;
    if (!notedForAnother(owner)) return;
    void import("@/lib/analysisCorpus/deviceClear")
      .then(({ forgetDeviceCopy }) => {
        // Another tab may have noted this account's own copy while the clearing code loaded.
        if (notedForAnother(owner)) forgetDeviceCopy();
      })
      .catch(() => {
        // The clearing code could not load (a deploy replaced it), so the copy goes without it.
        if (notedForAnother(owner)) clearWithoutModule();
      });
  }, [isLoaded, isSignedIn, userId]);

  return null;
}

/** The account the note names, null for none, or undefined when storage refuses the read. */
function readNote(): string | null | undefined {
  try {
    return window.localStorage.getItem(DEVICE_NOTE_KEY);
  } catch {
    return undefined;
  }
}

/** True when the note names a copy that is not `owner`'s. */
function notedForAnother(owner: string | null): boolean {
  const noted = readNote();
  return typeof noted === "string" && noted !== owner;
}

/** The fallback for forgetDeviceCopy (lib/analysisCorpus/deviceClear): forget the note, move the mark, delete. */
function clearWithoutModule(): void {
  try {
    window.localStorage.removeItem(DEVICE_NOTE_KEY);
    window.localStorage.setItem(DEVICE_CLEAR_KEY, String(Date.now()));
  } catch {
    // Storage is refused or full; the delete below still removes the copy.
  }
  deleteDatabase();
}

function deleteDatabase(): void {
  try {
    globalThis.indexedDB?.deleteDatabase(DEVICE_CORPUS_DB_NAME);
  } catch {
    // IndexedDB is refused for this document: there is nothing to delete.
  }
}
