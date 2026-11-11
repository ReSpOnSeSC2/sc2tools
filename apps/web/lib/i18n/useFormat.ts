"use client";

import { useSyncExternalStore } from "react";
import { getActiveFormatter, getServerFormatter, subscribeFormat, type Formatter } from "./format";

/**
 * The account's formatter for components: { number, percent, date, time,
 * dateTime, relative, duration, weekStartDay }. Hydration uses the same
 * stable en-US formatter as the server render, then the component
 * re-renders with this browser's preferences, so there is no mismatch.
 *
 * Example:
 *   const format = useFormat();
 *   <time dateTime={iso}>{format.dateTime(iso, { dateStyle: "medium", timeStyle: "short" })}</time>
 */
export function useFormat(): Formatter {
  return useSyncExternalStore(subscribeFormat, getActiveFormatter, getServerFormatter);
}
