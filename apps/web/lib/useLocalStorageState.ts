"use client";

import { useEffect, useRef, useState } from "react";

/**
 * SSR-safe persistent state.
 *
 * The earlier per-tab inline implementations used a lazy useState
 * initializer that called ``window.localStorage`` during the SSR
 * render — which simply returns the fallback there — and then again
 * during the client mount, producing a different value. React's
 * hydration treats that as a mismatch and can leave the component
 * (and its uncontrolled descendants — chip groups, custom inputs)
 * in an inconsistent state. A streamer's repro: the MinGamesPicker
 * chips became unclickable and the custom input went blank until
 * the page was reloaded.
 *
 * This hook keeps SSR and the first client render in sync by
 * always starting at ``fallback``, then upgrading to the stored
 * value in an effect that runs only on the client after mount.
 * The persist effect is gated on the same ``hydrated`` flag so it
 * cannot clobber a real stored value with the fallback before the
 * read effect ran.
 *
 * Values are JSON-encoded for forward-compat (objects, arrays, etc.);
 * non-string scalars round-trip cleanly. Malformed values fall back.
 *
 * @template T
 * @param key       localStorage key.
 * @param fallback  Default returned during SSR and before hydration,
 *                  and when the stored value is absent or malformed.
 * @param validate  Optional guard; runs against the parsed stored
 *                  value to confirm it's still a shape the caller
 *                  accepts. Return false to discard a corrupt value
 *                  and stay on ``fallback``.
 */
export function useLocalStorageState<T>(
  key: string,
  fallback: T,
  validate?: (raw: unknown) => raw is T,
): [T, (next: T) => void] {
  const [value, setValue] = useState<T>(fallback);
  const hydratedRef = useRef<boolean>(false);

  useEffect(() => {
    if (typeof window === "undefined") return;
    try {
      const raw = window.localStorage.getItem(key);
      if (raw !== null) {
        const parsed = JSON.parse(raw) as unknown;
        if (validate ? validate(parsed) : true) {
          setValue(parsed as T);
        }
      }
    } catch {
      // Malformed JSON or storage access denied. Stay on the
      // fallback; the next setValue call will overwrite the bad
      // entry with a fresh one.
    }
    hydratedRef.current = true;
    // Intentionally exclude ``fallback`` and ``validate`` from the
    // dependency array — they're typically inline / new each render
    // and re-running the hydration on every render would clobber the
    // user's just-set value. ``key`` is the only meaningful identity
    // for which slot to read.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);

  useEffect(() => {
    if (!hydratedRef.current) return;
    if (typeof window === "undefined") return;
    try {
      window.localStorage.setItem(key, JSON.stringify(value));
    } catch {
      // Storage quota exceeded or denied — non-fatal; we'll retry on
      // the next setValue.
    }
  }, [key, value]);

  return [value, setValue];
}

/**
 * Convenience wrapper around ``useLocalStorageState`` for the common
 * "positive integer" case (min-games pickers, page sizes, etc.).
 * Coerces stored strings to numbers and discards NaN / non-positive
 * values, which protects against an earlier version of the storage
 * format leaking through as ``null`` or a stringified number.
 */
export function useLocalStoragePositiveInt(
  key: string,
  fallback: number,
): [number, (next: number) => void] {
  return useLocalStorageState<number>(key, fallback, (raw): raw is number => {
    const n = typeof raw === "number" ? raw : Number(raw);
    return Number.isFinite(n) && n >= 1;
  });
}
