import { currentSeason, seasonRange } from "@/lib/seasonCatalog";
import type { LogicalSeason } from "@/lib/useSeasons";

// Date-range presets used by the global Analyzer filter bar.
//
// A preset is just a label + a function that returns a {since, until}
// range relative to "now". The filter bar serialises the chosen
// preset as a small id so we can round-trip it through localStorage
// and the URL, and so KPI cards can introspect "the user picked 7d"
// vs. "the user picked Season 67" to label themselves accurately.

export type PresetId =
  | "all"
  | "today"
  | "yesterday"
  | "last_week"
  | "last_7d"
  | "this_month"
  | "last_30d"
  | "last_90d"
  | "this_year"
  | "last_year"
  | "current_season"
  | `season:${number}`
  | "custom";

export type DateRange = {
  since?: Date;
  until?: Date;
};

export type Preset = {
  id: PresetId;
  label: string;
  /** Short label shown inside KPI cards ("7d", "Season 67", "All time"). */
  shortLabel: string;
  /** Resolve the preset to a concrete date range. */
  resolve: () => DateRange;
};

function startOfDay(d: Date): Date {
  const out = new Date(d);
  out.setHours(0, 0, 0, 0);
  return out;
}

function endOfDay(d: Date): Date {
  const out = new Date(d);
  out.setHours(23, 59, 59, 999);
  return out;
}

function addDays(d: Date, n: number): Date {
  const out = new Date(d);
  out.setDate(out.getDate() + n);
  return out;
}

function startOfMonth(d: Date): Date {
  return new Date(d.getFullYear(), d.getMonth(), 1, 0, 0, 0, 0);
}

function startOfYear(d: Date): Date {
  return new Date(d.getFullYear(), 0, 1, 0, 0, 0, 0);
}

/** ISO day-of-week (Mon=1 … Sun=7) for "last week" calculations. */
function startOfWeek(d: Date): Date {
  const out = startOfDay(d);
  const day = out.getDay() === 0 ? 7 : out.getDay();
  return addDays(out, -(day - 1));
}

export const PRESETS: ReadonlyArray<Preset> = [
  {
    id: "all",
    label: "All time",
    shortLabel: "All time",
    resolve: () => ({}),
  },
  {
    id: "today",
    label: "Today",
    shortLabel: "Today",
    resolve: () => {
      const now = new Date();
      return { since: startOfDay(now), until: endOfDay(now) };
    },
  },
  {
    id: "yesterday",
    label: "Yesterday",
    shortLabel: "Yesterday",
    resolve: () => {
      const y = addDays(new Date(), -1);
      return { since: startOfDay(y), until: endOfDay(y) };
    },
  },
  {
    id: "last_week",
    label: "Last week",
    shortLabel: "Last week",
    resolve: () => {
      const thisWeekStart = startOfWeek(new Date());
      const lastWeekStart = addDays(thisWeekStart, -7);
      const lastWeekEnd = addDays(thisWeekStart, -1);
      return { since: lastWeekStart, until: endOfDay(lastWeekEnd) };
    },
  },
  {
    id: "last_7d",
    label: "Last 7 days",
    shortLabel: "7d",
    resolve: () => {
      const now = new Date();
      return { since: startOfDay(addDays(now, -6)), until: endOfDay(now) };
    },
  },
  {
    id: "this_month",
    label: "This month",
    shortLabel: "This month",
    resolve: () => {
      const now = new Date();
      return { since: startOfMonth(now), until: endOfDay(now) };
    },
  },
  {
    id: "last_30d",
    label: "Last 30 days",
    shortLabel: "30d",
    resolve: () => {
      const now = new Date();
      return { since: startOfDay(addDays(now, -29)), until: endOfDay(now) };
    },
  },
  {
    id: "last_90d",
    label: "Last 90 days",
    shortLabel: "90d",
    resolve: () => {
      const now = new Date();
      return { since: startOfDay(addDays(now, -89)), until: endOfDay(now) };
    },
  },
  {
    id: "this_year",
    label: "This year",
    shortLabel: "YTD",
    resolve: () => {
      const now = new Date();
      return { since: startOfYear(now), until: endOfDay(now) };
    },
  },
  {
    id: "last_year",
    label: "Last 365 days",
    shortLabel: "1y",
    resolve: () => {
      const now = new Date();
      return { since: startOfDay(addDays(now, -364)), until: endOfDay(now) };
    },
  },
];

/**
 * Resolve any preset id (including dynamic `season:N`) into a date
 * range. When the SC2Pulse-backed `seasons` catalog is provided, a
 * `season:N` id uses the authoritative boundaries from there;
 * otherwise we fall back to the quarterly approximation in
 * `seasonCatalog.ts`.
 */
export function resolvePreset(
  id: PresetId,
  custom?: DateRange,
  seasons?: LogicalSeason[],
): DateRange {
  if (id === "custom") return custom || {};
  if (id === "current_season") {
    if (seasons && seasons.length > 0) {
      const cur = seasons.find((s) => s.isCurrent) || seasons[0];
      return resolvePreset(`season:${cur.number}` as PresetId, undefined, seasons);
    }
    // No catalog yet — fall back to the approximation so the first
    // paint still has a sensible window.
    const fallback = currentSeason();
    const r = seasonRange(fallback);
    return { since: r.start, until: r.end };
  }
  if (typeof id === "string" && id.startsWith("season:")) {
    const n = Number.parseInt(id.slice("season:".length), 10);
    if (!Number.isFinite(n)) return {};
    const fromCatalog = seasons?.find((s) => s.number === n);
    if (fromCatalog && (fromCatalog.start || fromCatalog.end)) {
      const since = fromCatalog.start ? new Date(fromCatalog.start) : undefined;
      const until = fromCatalog.end ? new Date(fromCatalog.end) : undefined;
      // Clamp the in-progress season's end to "now" so we never include
      // a future bound that filters out today's games.
      const now = new Date();
      const clampedUntil = until && until > now ? now : until;
      return { since, until: clampedUntil };
    }
    const r = seasonRange(n);
    return { since: r.start, until: r.end };
  }
  const preset = PRESETS.find((p) => p.id === id);
  return preset ? preset.resolve() : {};
}

/** Short label for a preset id — used inside KPI cards. */
export function shortLabelFor(
  id: PresetId,
  seasons?: LogicalSeason[],
): string {
  if (id === "current_season") {
    const cur = seasons?.find((s) => s.isCurrent);
    return cur ? `Season ${cur.number}` : "Current season";
  }
  if (typeof id === "string" && id.startsWith("season:")) {
    return `Season ${id.slice("season:".length)}`;
  }
  if (id === "custom") return "Custom";
  return PRESETS.find((p) => p.id === id)?.shortLabel || "All time";
}

/** Long label for a preset id — used in the picker label. */
export function longLabelFor(
  id: PresetId,
  seasons?: LogicalSeason[],
): string {
  if (id === "current_season") {
    const cur = seasons?.find((s) => s.isCurrent);
    return cur ? `Season ${cur.number} (current)` : "Current season";
  }
  if (typeof id === "string" && id.startsWith("season:")) {
    return `Season ${id.slice("season:".length)}`;
  }
  if (id === "custom") return "Custom range";
  return PRESETS.find((p) => p.id === id)?.label || "All time";
}

/**
 * The picker's default selection. "current_season" is a virtual id
 * resolved against the SC2Pulse catalog at hydration time; if the
 * catalog hasn't loaded yet we treat it like "all time" so nothing
 * filters out unexpectedly during the first paint.
 */
export const DEFAULT_PRESET: PresetId = "current_season" as PresetId;

/** Helper for KPI consumers — best-effort current-season label. */
export function currentSeasonPresetId(): PresetId {
  return `season:${currentSeason()}` as const;
}

/** Format a Date as `YYYY-MM-DD` for input[type=date]. */
export function toDateInputValue(d: Date | undefined): string {
  if (!d) return "";
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

/** Parse a `YYYY-MM-DD` input value back into a Date (start-of-day, local). */
export function fromDateInputValue(s: string): Date | undefined {
  if (!s) return undefined;
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s);
  if (!m) return undefined;
  const d = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  return Number.isNaN(d.getTime()) ? undefined : d;
}
