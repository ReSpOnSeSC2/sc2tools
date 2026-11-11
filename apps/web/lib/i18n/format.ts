/**
 * Shared, locale-aware formatting. Every date, time and number on the site
 * goes through here, so the account's language and region, 12/24-hour
 * clock and week start apply everywhere at once (a UI lint ratchet bans
 * new bare `toLocale*String` calls outside lib/i18n).
 *
 * - Plain functions (`formatNumber`, `formatDate`, ...) use the active
 *   preferences: this browser's copy of the account's choice, or the
 *   stable en-US server formatter during server rendering.
 * - React components that render during hydration use `useFormat()`
 *   (lib/i18n/useFormat), which starts from the server formatter and then
 *   follows the browser's preferences without a hydration mismatch.
 *
 * Intl objects are expensive to build, so each (locale, options) pair is
 * built once and reused.
 *
 * Example:
 *   formatNumber(12345.6)                         // "12,345.6" (en-US)
 *   createFormatter({ locale: "de-DE", hourCycle: "h23", weekStart: "auto" }).time(date, { hour: "numeric", minute: "2-digit" })
 */
import { readStoredAppearance, subscribeAppearance, type AppearancePrefs, type HourCycle, type WeekStart } from "@/lib/appearance";

export interface FormatPrefs {
  /** "auto" (the browser's language) or a BCP 47 tag. */
  locale: string;
  hourCycle: HourCycle;
  weekStart: WeekStart;
}

/** Server rendering never knows the viewer's browser: one stable format. */
export const SSR_FORMAT_PREFS: Readonly<FormatPrefs> = Object.freeze({ locale: "en-US", hourCycle: "auto", weekStart: "auto" });

export type DateInput = Date | string | number;
export type DurationStyle = "clock" | "short";

export interface Formatter {
  /** The locale passed to Intl; undefined means the browser's own. */
  readonly locale: string | undefined;
  readonly hourCycle: HourCycle;
  /** First day of the week, 0 = Sunday ... 6 = Saturday. */
  readonly weekStartDay: number;
  number(value: number | bigint, options?: Intl.NumberFormatOptions): string;
  /** A fraction (0.5) as a percent ("50%"). */
  percent(fraction: number, options?: Intl.NumberFormatOptions): string;
  /** Like Date#toLocaleDateString: year, month and day unless options pick fields. */
  date(value: DateInput, options?: Intl.DateTimeFormatOptions): string;
  /** Like Date#toLocaleTimeString: hour, minute and second unless options pick fields. */
  time(value: DateInput, options?: Intl.DateTimeFormatOptions): string;
  /** Like Date#toLocaleString: date and time unless options pick fields. */
  dateTime(value: DateInput, options?: Intl.DateTimeFormatOptions): string;
  /** Compact age ("45s ago", "5m ago", "3h ago", "2d ago"), then the date. */
  relative(value: DateInput, now?: number): string;
  /** Seconds as "1:05" / "1:02:03" (clock) or "1h 2m" / "45s" (short). */
  duration(seconds: number, style?: DurationStyle): string;
}

// The fields ECMA-402 checks before adding Date#toLocale*String defaults.
const DATE_FIELDS = ["weekday", "year", "month", "day"] as const;
const TIME_FIELDS = ["dayPeriod", "hour", "minute", "second", "fractionalSecondDigits"] as const;
const DATE_DEFAULTS: Intl.DateTimeFormatOptions = { year: "numeric", month: "numeric", day: "numeric" };
const TIME_DEFAULTS: Intl.DateTimeFormatOptions = { hour: "numeric", minute: "numeric", second: "numeric" };
const MAX_CACHED = 400;

const dateTimeCache = new Map<string, Intl.DateTimeFormat>();
const numberCache = new Map<string, Intl.NumberFormat>();

function cacheKey(locale: string | undefined, options: object): string {
  const entries = Object.entries(options).filter(([, value]) => value !== undefined).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `${locale ?? ""}|${JSON.stringify(entries)}`;
}

function cached<T>(cache: Map<string, T>, key: string, build: () => T): T {
  let value = cache.get(key);
  if (value === undefined) {
    if (cache.size >= MAX_CACHED) cache.clear();
    value = build();
    cache.set(key, value);
  }
  return value;
}

/** A shared Intl.DateTimeFormat for this locale and options. */
export function dateTimeFormat(locale: string | undefined, options: Intl.DateTimeFormatOptions = {}): Intl.DateTimeFormat {
  return cached(dateTimeCache, cacheKey(locale, options), () => new Intl.DateTimeFormat(locale, options));
}

/** A shared Intl.NumberFormat for this locale and options. */
export function numberFormat(locale: string | undefined, options: Intl.NumberFormatOptions = {}): Intl.NumberFormat {
  return cached(numberCache, cacheKey(locale, options), () => new Intl.NumberFormat(locale, options));
}

const has = (options: Intl.DateTimeFormatOptions, fields: readonly string[]) =>
  fields.some((field) => (options as Record<string, unknown>)[field] !== undefined);

/**
 * The options the matching Date#toLocale*String would use (ECMA-402
 * ToDateTimeOptions), so a converted call keeps its output.
 */
export function withDateTimeDefaults(options: Intl.DateTimeFormatOptions, required: "date" | "time" | "any"): Intl.DateTimeFormatOptions {
  if (options.dateStyle !== undefined || options.timeStyle !== undefined) return options;
  const needDefaults = !(required !== "time" && has(options, DATE_FIELDS)) && !(required !== "date" && has(options, TIME_FIELDS));
  if (!needDefaults) return options;
  if (required === "date") return { ...DATE_DEFAULTS, ...options };
  if (required === "time") return { ...TIME_DEFAULTS, ...options };
  return { ...DATE_DEFAULTS, ...TIME_DEFAULTS, ...options };
}

/** Add the account's clock to options that show an hour, unless the caller chose one. */
export function withHourCycle(options: Intl.DateTimeFormatOptions, hourCycle: HourCycle): Intl.DateTimeFormatOptions {
  if (hourCycle === "auto" || options.hour12 !== undefined || options.hourCycle !== undefined) return options;
  if (options.hour === undefined && options.timeStyle === undefined) return options;
  return { ...options, hourCycle };
}

const DAY_NAMES = ["sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday"] as const;
export type DayName = (typeof DAY_NAMES)[number];
const WEEK_START_DAYS: Record<Exclude<WeekStart, "auto">, number> = { sunday: 0, monday: 1, saturday: 6 };
// CLDR first-day-of-week regions, for runtimes without Intl.Locale week info.
const SUNDAY_REGIONS = new Set("AG AS BD BR BS BT BW BZ CA CO DM DO ET GT GU HK HN ID IL IN JM JP KE KH KR LA MH MM MO MT MX MZ NI NP PA PE PH PK PR PT PY SA SG SV TH TT TW UM US VE VI WS YE ZA ZW".split(" "));
const SATURDAY_REGIONS = new Set("AE AF BH DJ DZ EG IQ IR JO KW LY OM QA SD SY".split(" "));

/** 0 = Sunday ... 6 = Saturday, as a lowercase English day name. */
export function dayName(day: number): DayName {
  return DAY_NAMES[((Math.trunc(day) % 7) + 7) % 7];
}

/** The locale's first day of the week (0 = Sunday ... 6 = Saturday). */
export function weekStartForLocale(locale: string | undefined): number {
  try {
    const tag = new Intl.Locale(locale ?? new Intl.DateTimeFormat().resolvedOptions().locale);
    const info = (tag as Intl.Locale & { getWeekInfo?: () => { firstDay: number }; weekInfo?: { firstDay: number } });
    const firstDay = info.getWeekInfo?.().firstDay ?? info.weekInfo?.firstDay;
    if (typeof firstDay === "number" && firstDay >= 1 && firstDay <= 7) return firstDay % 7;
    const region = tag.region ?? tag.maximize().region;
    if (region && SUNDAY_REGIONS.has(region)) return 0;
    if (region && SATURDAY_REGIONS.has(region)) return 6;
    return 1;
  } catch {
    return 1;
  }
}

function toDate(value: DateInput): Date {
  return value instanceof Date ? value : new Date(value);
}

/** Build a formatter for explicit preferences (Settings previews, tests). */
export function createFormatter(prefs: FormatPrefs): Formatter {
  const locale = prefs.locale === "auto" ? undefined : prefs.locale;
  const hourCycle = prefs.hourCycle;
  const weekStartDay = prefs.weekStart === "auto" ? weekStartForLocale(locale) : WEEK_START_DAYS[prefs.weekStart];
  const formatDateTime = (value: DateInput, options: Intl.DateTimeFormatOptions, required: "date" | "time" | "any") => {
    const date = toDate(value);
    // Date#toLocale*String reports an invalid date instead of throwing.
    if (!Number.isFinite(date.getTime())) return "Invalid Date";
    return dateTimeFormat(locale, withHourCycle(withDateTimeDefaults(options, required), hourCycle)).format(date);
  };
  const formatter: Formatter = {
    locale,
    hourCycle,
    weekStartDay,
    number: (value, options) => numberFormat(locale, options).format(value),
    percent: (fraction, options) => numberFormat(locale, { style: "percent", maximumFractionDigits: 0, ...options }).format(fraction),
    date: (value, options = {}) => formatDateTime(value, options, "date"),
    time: (value, options = {}) => formatDateTime(value, options, "time"),
    dateTime: (value, options = {}) => formatDateTime(value, options, "any"),
    relative: (value, now = Date.now()) => {
      const date = toDate(value);
      if (!Number.isFinite(date.getTime())) return "—";
      const sec = Math.max(0, (now - date.getTime()) / 1000);
      if (sec < 60) return `${Math.round(sec)}s ago`;
      if (sec < 3600) return `${Math.round(sec / 60)}m ago`;
      if (sec < 86400) return `${Math.round(sec / 3600)}h ago`;
      if (sec < 604800) return `${Math.round(sec / 86400)}d ago`;
      return formatDateTime(date, {}, "date");
    },
    duration: (seconds, style = "clock") => {
      if (!Number.isFinite(seconds)) return "—";
      const total = Math.max(0, Math.round(seconds));
      const h = Math.floor(total / 3600), m = Math.floor((total % 3600) / 60), s = total % 60;
      if (style === "short") return h ? `${h}h ${m}m` : m ? `${m}m ${s}s` : `${s}s`;
      const pad = (n: number) => String(n).padStart(2, "0");
      return h ? `${h}:${pad(m)}:${pad(s)}` : `${m}:${pad(s)}`;
    },
  };
  return formatter;
}

/** The format part of the account's appearance preferences. */
export function formatPrefsOf(appearance: Pick<AppearancePrefs, "locale" | "hourCycle" | "weekStart">): FormatPrefs {
  return { locale: appearance.locale, hourCycle: appearance.hourCycle, weekStart: appearance.weekStart };
}

let serverFormatter: Formatter | null = null;
let browserState: { appearance: AppearancePrefs; formatter: Formatter } | null = null;

/** The stable en-US formatter used while rendering on the server. */
export function getServerFormatter(): Formatter {
  serverFormatter ??= createFormatter(SSR_FORMAT_PREFS);
  return serverFormatter;
}

/** The formatter for this browser's preferences (server: en-US). */
export function getActiveFormatter(): Formatter {
  if (typeof window === "undefined") return getServerFormatter();
  const appearance = readStoredAppearance();
  if (!browserState || browserState.appearance !== appearance) {
    browserState = { appearance, formatter: createFormatter(formatPrefsOf(appearance)) };
  }
  return browserState.formatter;
}

/** Notifies when the active formatter changes (Settings save, another tab). */
export function subscribeFormat(listener: () => void): () => void {
  return subscribeAppearance(listener);
}

export const formatNumber = (value: number | bigint, options?: Intl.NumberFormatOptions): string => getActiveFormatter().number(value, options);
export const formatPercent = (fraction: number, options?: Intl.NumberFormatOptions): string => getActiveFormatter().percent(fraction, options);
export const formatDate = (value: DateInput, options?: Intl.DateTimeFormatOptions): string => getActiveFormatter().date(value, options);
export const formatTime = (value: DateInput, options?: Intl.DateTimeFormatOptions): string => getActiveFormatter().time(value, options);
export const formatDateTime = (value: DateInput, options?: Intl.DateTimeFormatOptions): string => getActiveFormatter().dateTime(value, options);
export const formatRelative = (value: DateInput, now?: number): string => getActiveFormatter().relative(value, now);
export const formatDuration = (seconds: number, style?: DurationStyle): string => getActiveFormatter().duration(seconds, style);
/** First day of the week for date presets and weekly charts (0 = Sunday). */
export const activeWeekStartDay = (): number => getActiveFormatter().weekStartDay;

/**
 * "YYYY-MM-DD" in this browser's time zone, for date inputs and keys. A
 * machine format: never localized.
 *
 * Example: localIsoDate(new Date(2026, 10, 9)) // "2026-11-09"
 */
export function localIsoDate(value: DateInput = new Date()): string {
  const date = toDate(value);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}
