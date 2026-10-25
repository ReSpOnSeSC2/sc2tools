const monthYear = new Intl.DateTimeFormat("en-US", { month: "short", year: "numeric", timeZone: "UTC" });
const calendarDate = new Intl.DateTimeFormat("en-US", { month: "long", day: "numeric", year: "numeric", timeZone: "UTC" });

/** Public SSR markup must match across browser locale, timezone and format
 * preferences. Relative ages and private dashboard formatting stay separate. */
export function publicDate(value: string | null | undefined, full = false): string {
  const date = value ? new Date(value) : null;
  return date && Number.isFinite(date.getTime()) ? (full ? calendarDate : monthYear).format(date) : "—";
}
