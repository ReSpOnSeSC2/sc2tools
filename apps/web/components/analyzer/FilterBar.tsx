"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { CalendarRange, ChevronDown, X } from "lucide-react";
import { useFilters } from "@/lib/filterContext";
import {
  PRESETS,
  resolvePreset,
  toDateInputValue,
  fromDateInputValue,
  longLabelFor,
  type PresetId,
} from "@/lib/datePresets";
import { listSeasons, currentSeason, seasonRange, formatSeasonRange } from "@/lib/seasonCatalog";
import type { LogicalSeason } from "@/lib/useSeasons";

const SEASONS_TO_SHOW = 16;

/**
 * Global date-range filter that drives every analyzer tab. Selection
 * is held in the shared filter context, so the same `since/until` hits
 * the Opponents, Strategies, Trends, Maps, Builds, Map intel and
 * Activity tabs at once.
 *
 * The picker presents three groups:
 *   - Quick presets (today, last 7d, this month, last 30d, last year, etc.)
 *   - Recent SC2 ladder seasons — sourced from SC2Pulse via /v1/seasons
 *     so the boundaries are authoritative; falls back to the local
 *     quarterly approximation if the catalog hasn't arrived yet.
 *   - Custom range (two date inputs)
 *
 * Mobile-friendly: the popover collapses into a single-column scroll
 * region, ESC closes it, the backdrop dismisses on tap, and every tap
 * target is at least 44px tall.
 */
export function FilterBar() {
  const { filters, setFilters, seasons } = useFilters();
  const presetId: PresetId = filters.preset || "all";
  const [open, setOpen] = useState(false);
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const [customStart, setCustomStart] = useState<string>(() =>
    filters.since ? toDateInputValue(new Date(filters.since)) : "",
  );
  const [customEnd, setCustomEnd] = useState<string>(() =>
    filters.until ? toDateInputValue(new Date(filters.until)) : "",
  );

  // Keep the local custom-range inputs synced with the active filter
  // so reopening the picker after picking "Last 30 days" shows the
  // resolved dates, not the user's previously typed-in custom range.
  useEffect(() => {
    setCustomStart(filters.since ? toDateInputValue(new Date(filters.since)) : "");
    setCustomEnd(filters.until ? toDateInputValue(new Date(filters.until)) : "");
  }, [filters.since, filters.until]);

  // ESC closes the popover and returns focus to the trigger.
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        setOpen(false);
        triggerRef.current?.focus();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open]);

  const apply = (id: PresetId, opts?: { since?: Date; until?: Date }) => {
    if (id === "custom") {
      setFilters({
        ...filters,
        preset: "custom",
        since: opts?.since ? opts.since.toISOString() : undefined,
        until: opts?.until ? opts.until.toISOString() : undefined,
      });
      setOpen(false);
      return;
    }
    const range = resolvePreset(id, undefined, seasons);
    setFilters({
      ...filters,
      preset: id,
      since: range.since ? range.since.toISOString() : undefined,
      until: range.until ? range.until.toISOString() : undefined,
    });
    setOpen(false);
  };

  const onApplyCustom = () => {
    const since = fromDateInputValue(customStart);
    const until = fromDateInputValue(customEnd);
    if (until) until.setHours(23, 59, 59, 999);
    apply("custom", { since, until });
  };

  const triggerLabel = useMemo(
    () => longLabelFor(presetId, seasons),
    [presetId, seasons],
  );

  return (
    <div className="flex flex-wrap items-center gap-3">
      <span className="inline-flex items-center gap-1.5 text-xs uppercase tracking-wider text-text-dim">
        <CalendarRange className="h-3.5 w-3.5" aria-hidden />
        Date range
      </span>

      <div className="relative">
        <button
          ref={triggerRef}
          type="button"
          onClick={() => setOpen((v) => !v)}
          aria-haspopup="dialog"
          aria-expanded={open}
          className="inline-flex min-h-[44px] items-center gap-2 rounded-md border border-border bg-bg-surface px-3 py-2 text-sm text-text transition-colors hover:bg-bg-elevated focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-2 focus-visible:ring-offset-bg"
        >
          <span className="font-medium">{triggerLabel}</span>
          <ChevronDown className="h-3.5 w-3.5 text-text-muted" aria-hidden />
        </button>

        {open ? (
          <>
            <button
              type="button"
              aria-label="Close date range picker"
              className="fixed inset-0 z-30 bg-black/40 backdrop-blur-[1px] sm:bg-transparent sm:backdrop-blur-0"
              onClick={() => setOpen(false)}
            />
            <div
              role="dialog"
              aria-modal="true"
              aria-label="Pick a date range"
              className={[
                // Mobile: full-width sheet anchored to the bottom; desktop:
                // popover anchored under the trigger. Either way it
                // never exceeds the viewport.
                "fixed inset-x-2 bottom-2 z-40 max-h-[80vh] overflow-y-auto rounded-xl border border-border bg-bg-surface p-4 shadow-card",
                "sm:absolute sm:inset-x-auto sm:bottom-auto sm:left-0 sm:right-auto sm:top-full sm:mt-1 sm:max-h-[70vh] sm:w-[min(92vw,640px)] sm:rounded-lg sm:p-3",
              ].join(" ")}
            >
              <div className="mb-2 flex items-center justify-between sm:hidden">
                <h3 className="text-h3 font-semibold text-text">Date range</h3>
                <button
                  type="button"
                  aria-label="Close"
                  onClick={() => setOpen(false)}
                  className="inline-flex h-9 w-9 items-center justify-center rounded-md text-text-muted hover:bg-bg-elevated hover:text-text focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
                >
                  <X className="h-4 w-4" aria-hidden />
                </button>
              </div>

              <div className="grid grid-cols-1 gap-4 md:grid-cols-3 md:gap-3">
                <PresetGroup
                  title="Quick"
                  active={presetId}
                  onPick={(id) => apply(id)}
                  ids={[
                    "all",
                    "today",
                    "yesterday",
                    "last_week",
                    "last_7d",
                    "this_month",
                    "last_30d",
                    "last_90d",
                    "this_year",
                    "last_year",
                  ]}
                />

                <SeasonGroup
                  title="Season"
                  active={presetId}
                  onPick={(id) => apply(id)}
                  seasons={seasons}
                />

                <div className="space-y-2">
                  <h4 className="text-xs uppercase tracking-wider text-text-dim">
                    Custom
                  </h4>
                  <label className="block">
                    <span className="text-[11px] uppercase tracking-wider text-text-dim">
                      Start
                    </span>
                    <input
                      type="date"
                      value={customStart}
                      max={customEnd || undefined}
                      onChange={(e) => setCustomStart(e.target.value)}
                      className="input mt-0.5 min-h-[44px] w-full"
                    />
                  </label>
                  <label className="block">
                    <span className="text-[11px] uppercase tracking-wider text-text-dim">
                      End
                    </span>
                    <input
                      type="date"
                      value={customEnd}
                      min={customStart || undefined}
                      onChange={(e) => setCustomEnd(e.target.value)}
                      className="input mt-0.5 min-h-[44px] w-full"
                    />
                  </label>
                  <button
                    type="button"
                    onClick={onApplyCustom}
                    disabled={!customStart && !customEnd}
                    className="mt-1 inline-flex min-h-[44px] w-full items-center justify-center rounded-md border border-border bg-accent/15 px-3 py-2 text-sm font-medium text-accent transition-colors hover:bg-accent/25 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-2 focus-visible:ring-offset-bg disabled:cursor-not-allowed disabled:opacity-40 disabled:hover:bg-accent/15"
                  >
                    Apply custom range
                  </button>
                </div>
              </div>
            </div>
          </>
        ) : null}
      </div>

      {filters.since || filters.until ? (
        <span className="text-xs text-text-dim">
          {filters.since
            ? new Date(filters.since).toLocaleDateString()
            : "—"}{" "}
          →{" "}
          {filters.until
            ? new Date(filters.until).toLocaleDateString()
            : "now"}
        </span>
      ) : null}

      <ExcludeTooShortToggle />
    </div>
  );
}

/**
 * "Hide too-short games" toggle. Replays that ended in under 30
 * seconds get tagged "<X>v<Y> - Game Too Short" by the strategy
 * detector on BOTH `myBuild` and `opponent.strategy`. This checkbox
 * sets ``exclude_too_short=1`` on the filter context, which
 * `filtersToQuery` forwards to the API; `gamesMatchStage` then adds
 * a negated regex on whichever side isn't already constrained.
 *
 * Drives every analyzer tab (Opponents, Strategies, Trends, Maps,
 * Builds) in one shot because they all read from the same shared
 * `useFilters()` context.
 *
 * Default off so historical bookmarks and shared links stay
 * reproducible.
 */
function ExcludeTooShortToggle() {
  const { filters, setFilters } = useFilters();
  // Default-on: a fresh session lands with `exclude_too_short: true`
  // from AnalyzerProvider. The user's explicit choice persists via
  // localStorage as a boolean (true OR false), so toggle-off survives
  // refreshes. ``undefined`` only appears transiently during hydration
  // and is treated as on.
  const enabled = filters.exclude_too_short !== false;
  return (
    <label
      // Mobile compact: matches the visual weight of the "Date range"
      // label on the left. No border / no bg so it doesn't look like
      // a second card sitting inside the FilterBar's own bordered
      // surface. `sm:ml-auto` pushes it right on the desktop
      // single-row layout. On mobile it wraps to its own line and
      // stays left-aligned under "Date range" instead of being shoved
      // to the right edge under the trigger button.
      className={[
        "inline-flex cursor-pointer items-center gap-1.5 sm:ml-auto",
        "py-1 text-xs uppercase tracking-wider text-text-dim",
        "transition-colors hover:text-text",
        "focus-within:text-text",
      ].join(" ")}
      title="Drop replays that ended in under 45 seconds (no build order developed) from every tab and KPI. On by default."
    >
      <input
        type="checkbox"
        checked={enabled}
        onChange={(e) =>
          // Store the boolean explicitly (true or false). false is
          // needed in localStorage to remember the user's opt-out;
          // ``filtersToQuery`` drops false from the URL so the
          // query string stays clean when the toggle is at its
          // no-op state.
          setFilters({ ...filters, exclude_too_short: e.target.checked })
        }
        className="h-3.5 w-3.5 cursor-pointer accent-accent focus:outline-none focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-2 focus-visible:ring-offset-bg"
        aria-label="Exclude games shorter than 30 seconds"
      />
      <span className={enabled ? "text-text" : undefined}>
        Hide too-short
      </span>
    </label>
  );
}

function PresetGroup({
  title,
  active,
  onPick,
  ids,
}: {
  title: string;
  active: PresetId;
  onPick: (id: PresetId) => void;
  ids: PresetId[];
}) {
  return (
    <div className="space-y-2">
      <h4 className="text-xs uppercase tracking-wider text-text-dim">{title}</h4>
      <ul className="-mx-1 flex flex-col gap-0.5">
        {ids.map((id) => {
          const preset = PRESETS.find((p) => p.id === id);
          if (!preset) return null;
          const selected = active === id;
          return (
            <li key={id}>
              <button
                type="button"
                onClick={() => onPick(id)}
                aria-pressed={selected}
                className={[
                  "flex min-h-[44px] w-full items-center justify-between rounded-md px-3 py-2 text-left text-sm",
                  "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-2 focus-visible:ring-offset-bg",
                  selected
                    ? "bg-accent/15 text-accent"
                    : "text-text-muted hover:bg-bg-elevated hover:text-text",
                ].join(" ")}
              >
                <span>{preset.label}</span>
              </button>
            </li>
          );
        })}
      </ul>
    </div>
  );
}

function SeasonGroup({
  title,
  active,
  onPick,
  seasons,
}: {
  title: string;
  active: PresetId;
  onPick: (id: PresetId) => void;
  seasons: LogicalSeason[];
}) {
  // Prefer the SC2Pulse catalog when present; otherwise the local
  // quarterly approximation lets the picker render before the API
  // round-trip completes.
  const usingFallback = seasons.length === 0;
  const fallbackList = useMemo(() => listSeasons(SEASONS_TO_SHOW), []);
  const fallbackCurrent = useMemo(() => currentSeason(), []);

  return (
    <div className="space-y-2">
      <div className="flex items-baseline justify-between">
        <h4 className="text-xs uppercase tracking-wider text-text-dim">{title}</h4>
        {usingFallback ? (
          <span
            className="text-[10px] uppercase tracking-wider text-text-dim/70"
            title="Catalog not loaded yet — showing approximate boundaries. Real boundaries arrive once SC2Pulse responds."
          >
            approx
          </span>
        ) : null}
      </div>
      <ul className="-mx-1 flex max-h-64 flex-col gap-0.5 overflow-y-auto pr-1 sm:max-h-72">
        <li>
          <button
            type="button"
            onClick={() => onPick("current_season")}
            aria-pressed={active === "current_season"}
            className={[
              "flex min-h-[44px] w-full flex-col items-start rounded-md px-3 py-2 text-left",
              "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-2 focus-visible:ring-offset-bg",
              active === "current_season"
                ? "bg-accent/15 text-accent"
                : "text-text-muted hover:bg-bg-elevated hover:text-text",
            ].join(" ")}
          >
            <span className="text-sm font-medium">Current season</span>
            <span className="text-[11px] text-text-dim">Auto-tracks the live season</span>
          </button>
        </li>
        {usingFallback
          ? fallbackList.map((n) => (
              <SeasonRow
                key={n}
                number={n}
                start={undefined}
                end={undefined}
                isCurrent={n === fallbackCurrent}
                approx
                active={active}
                onPick={onPick}
                fallbackRangeLabel={formatSeasonRange(seasonRange(n))}
              />
            ))
          : seasons.map((s) => (
              <SeasonRow
                key={s.number}
                number={s.number}
                start={s.start}
                end={s.end}
                isCurrent={s.isCurrent}
                approx={false}
                active={active}
                onPick={onPick}
              />
            ))}
      </ul>
    </div>
  );
}

function SeasonRow({
  number,
  start,
  end,
  isCurrent,
  approx,
  active,
  onPick,
  fallbackRangeLabel,
}: {
  number: number;
  start: string | null | undefined;
  end: string | null | undefined;
  isCurrent: boolean;
  approx: boolean;
  active: PresetId;
  onPick: (id: PresetId) => void;
  fallbackRangeLabel?: string;
}) {
  const id = `season:${number}` as PresetId;
  const selected = active === id;
  const label =
    fallbackRangeLabel
    || (start && end ? `${formatDate(start)} – ${formatDate(end)}` : null);
  return (
    <li>
      <button
        type="button"
        onClick={() => onPick(id)}
        aria-pressed={selected}
        title={label || ""}
        className={[
          "flex min-h-[44px] w-full flex-col items-start rounded-md px-3 py-2 text-left",
          "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-2 focus-visible:ring-offset-bg",
          selected
            ? "bg-accent/15 text-accent"
            : "text-text-muted hover:bg-bg-elevated hover:text-text",
        ].join(" ")}
      >
        <span className="text-sm font-medium">
          Season {number}
          {isCurrent ? (
            <span className="ml-1.5 align-middle text-[10px] uppercase tracking-wider text-accent-cyan">
              current
            </span>
          ) : null}
          {approx ? (
            <span className="ml-1.5 align-middle text-[10px] uppercase tracking-wider text-text-dim/70">
              approx
            </span>
          ) : null}
        </span>
        {label ? <span className="text-[11px] text-text-dim">{label}</span> : null}
      </button>
    </li>
  );
}

function formatDate(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
    year: "numeric",
  });
}
