import { useSyncExternalStore } from "react";

export type CheckInBusy = "confirm" | "skip" | "notes" | "opponent" | null;

// Retain only active writes. Mounted editors subscribe separately, so opening
// another game never leaves its IDs or request state in a permanent cache.
const pending = new Map<string, { kind: Exclude<CheckInBusy, null> }>();
const listeners = new Set<() => void>();
const notify = () => { for (const listener of listeners) listener(); };
const subscribe = (listener: () => void) => {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
};

export function checkInPendingKey(owner: string | null, gameId: string): string | null {
  return owner && gameId ? JSON.stringify([owner, gameId]) : null;
}

export function useCheckInPending(key: string | null): CheckInBusy {
  return useSyncExternalStore(subscribe, () => key ? pending.get(key)?.kind ?? null : null, () => null);
}

/** A synchronous claim prevents duplicate dispatch even before React renders. */
export function claimCheckInPending(key: string, kind: Exclude<CheckInBusy, null>): (() => void) | null {
  if (pending.has(key)) return null;
  const entry = { kind };
  pending.set(key, entry);
  notify();
  return () => {
    // A retired request's finally must not unlock a newer request for this key.
    if (pending.get(key) !== entry) return;
    pending.delete(key);
    notify();
  };
}
