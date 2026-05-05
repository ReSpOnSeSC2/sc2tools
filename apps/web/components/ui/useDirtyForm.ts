"use client";

import { useEffect, useMemo, useRef, useState } from "react";

/**
 * useDirtyForm — track a draft state vs. its server counterpart.
 *
 * Pass the latest server-fetched value as `serverValue`. The hook
 * exposes a `draft` mirroring it until the user mutates via `setDraft`,
 * after which `dirty` flips true and `reset()` snaps draft back to the
 * server value. `markSaved()` should be called once a successful save
 * round-trips so the next server tick won't be treated as an external edit.
 */
export interface UseDirtyFormResult<T> {
  draft: T;
  setDraft: (next: T | ((prev: T) => T)) => void;
  dirty: boolean;
  reset: () => void;
  markSaved: () => void;
}

export function useDirtyForm<T>(
  serverValue: T | undefined,
  initial: T,
): UseDirtyFormResult<T> {
  const [draft, setDraftState] = useState<T>(initial);
  const [hydrated, setHydrated] = useState(false);
  const lastServerRef = useRef<string>("");
  const lastSavedRef = useRef<string>("");

  // When the server value updates, only overwrite the draft if the user
  // hasn't started editing. After a save, we reset the dirty baseline.
  useEffect(() => {
    if (serverValue === undefined) return;
    const json = stableStringify(serverValue);
    const isExternalUpdate = json !== lastServerRef.current;
    lastServerRef.current = json;

    if (!hydrated) {
      setDraftState(serverValue);
      lastSavedRef.current = json;
      setHydrated(true);
      return;
    }
    // External update + draft was clean → adopt the new server value.
    const draftJson = stableStringify(draft);
    const wasClean = draftJson === lastSavedRef.current;
    if (isExternalUpdate && wasClean) {
      setDraftState(serverValue);
      lastSavedRef.current = json;
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [serverValue]);

  const dirty = useMemo(() => {
    if (!hydrated) return false;
    return stableStringify(draft) !== lastSavedRef.current;
  }, [draft, hydrated]);

  return {
    draft,
    setDraft: setDraftState,
    dirty,
    reset: () => {
      if (serverValue !== undefined) {
        setDraftState(serverValue);
        lastSavedRef.current = stableStringify(serverValue);
      }
    },
    markSaved: () => {
      lastSavedRef.current = stableStringify(draft);
    },
  };
}

function stableStringify(value: unknown): string {
  if (value === null || value === undefined) return String(value);
  if (typeof value !== "object") return JSON.stringify(value);
  return JSON.stringify(value, (_k, v) => {
    if (v && typeof v === "object" && !Array.isArray(v)) {
      return Object.keys(v as Record<string, unknown>)
        .sort()
        .reduce<Record<string, unknown>>((acc, k) => {
          acc[k] = (v as Record<string, unknown>)[k];
          return acc;
        }, {});
    }
    return v;
  });
}
