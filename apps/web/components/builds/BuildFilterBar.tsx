"use client";

import { useRef } from "react";
import { usePageSearchShortcut } from "@/lib/usePageSearchShortcut";
import { Search, X } from "lucide-react";
import { Field } from "@/components/ui/Field";
import { Icon } from "@/components/ui/Icon";
import { Input } from "@/components/ui/Input";
import { Select } from "@/components/ui/Select";
import { Toggle } from "@/components/ui/Toggle";
import {
  COMMON_MATCHUPS,
  raceIconName,
  raceLetter,
  raceTint,
  type Race,
} from "@/lib/race";

export type BuildSortKey = "updated" | "winRate" | "games" | "name";

export interface BuildFilterState {
  search: string;
  /** "All" or "PvT" / "PvZ" / etc. */
  matchup: string;
  sort: BuildSortKey;
  hideEmpty: boolean;
}

export interface BuildFilterBarProps {
  value: BuildFilterState;
  onChange: (next: BuildFilterState) => void;
  /** Optional sample-size summary shown to the right of the filter. */
  total: number;
  libraryTotal?: number | null;
  onSearchCommit?: () => void;
  updating?: boolean;
  onClearFilters?: () => void;
}

const SORT_OPTIONS: ReadonlyArray<{ value: BuildSortKey; label: string }> = [
  { value: "updated", label: "Recently edited" },
  { value: "winRate", label: "Win rate" },
  { value: "games", label: "Most games" },
  { value: "name", label: "Name (A→Z)" },
];

function matchupKey(my: Race, vs: Race): string {
  return `${raceLetter(my)}v${raceLetter(vs)}`;
}

/**
 * BuildFilterBar — search + matchup pills + sort + hide-empty toggle.
 * Stacks vertically on mobile; the matchup row scrolls horizontally
 * if it overflows.
 */
export function BuildFilterBar({
  value,
  onChange,
  total,
  libraryTotal, onSearchCommit, updating, onClearFilters,
}: BuildFilterBarProps) {
  const searchRef = useRef<HTMLInputElement>(null);
  usePageSearchShortcut(searchRef);
  const activeCount = Number(!!value.search) + Number(value.matchup !== "All") + Number(value.hideEmpty);
  function update<K extends keyof BuildFilterState>(
    key: K,
    next: BuildFilterState[K],
  ) {
    onChange({ ...value, [key]: next });
  }

  return (
    <section
      aria-label="Filter custom builds"
      className="space-y-3 rounded-xl border-2 border-line bg-bg-surface p-4 shadow-hard"
    >
      <div className="flex flex-col gap-3 sm:flex-row sm:items-end">
        <Field
          label="Search"
          htmlFor="builds-search"
          className="min-w-0 flex-1"
        >
          <div id="builds-search-wrap" className="relative">
            <Search
              aria-hidden
              className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-text-dim"
            />
            <Input
              ref={searchRef}
              onKeyDown={(event) => { if (event.key === "Enter") onSearchCommit?.(); }}
              id="builds-search"
              value={value.search}
              onChange={(e) => update("search", e.target.value)}
              placeholder="Search builds, matchups, openers…"
              className="pl-9 pr-12"
              autoComplete="off"
              maxLength={200}
            />
            {value.search ? <button type="button" aria-label="Clear search" onClick={() => update("search", "")} className="absolute right-0 top-0 flex h-11 w-11 items-center justify-center"><X className="h-4 w-4" aria-hidden /></button> : null}
          </div>
        </Field>
        <Field
          label="Sort"
          htmlFor="builds-sort"
          className="sm:w-56"
        >
          <Select
            id="builds-sort"
            value={value.sort}
            onChange={(e) => update("sort", e.target.value as BuildSortKey)}
          >
            {SORT_OPTIONS.map((o) => (
              <option key={o.value} value={o.value}>
                {o.label}
              </option>
            ))}
          </Select>
        </Field>
      </div>
      <div className="flex flex-wrap items-center justify-between gap-3">
        <MatchupPills
          value={value.matchup}
          onChange={(m) => update("matchup", m)}
        />
        <label className="inline-flex min-h-[44px] items-center gap-2 text-caption text-text-muted">
          <Toggle
            checked={value.hideEmpty}
            onChange={(next) => update("hideEmpty", next)}
            label="Hide builds with no games tracked"
          />
          <span>Hide empty</span>
        </label>
      </div>
      <div className="flex flex-wrap items-center gap-3 text-caption text-text-dim" aria-live="polite">
        <span>{activeCount ? libraryTotal != null ? `${total} of ${libraryTotal} builds match` : `${total} builds match` : `${total} build${total === 1 ? "" : "s"}`}</span>
        {updating ? <span role="status">Updating…</span> : null}
        {activeCount > 0 && onClearFilters ? <button className="min-h-11 px-2 text-accent" onClick={onClearFilters}>Clear filters ({activeCount})</button> : null}
      </div>
    </section>
  );
}

interface MatchupPillsProps {
  value: string;
  onChange: (next: string) => void;
}

function MatchupPills({ value, onChange }: MatchupPillsProps) {
  return (
    <div
      role="radiogroup"
      aria-label="Filter by matchup"
      className="-mx-1 flex flex-wrap gap-1.5 overflow-x-auto px-1"
    >
      <PillButton
        active={value === "All"}
        onClick={() => onChange("All")}
      >
        All
      </PillButton>
      {COMMON_MATCHUPS.map(({ my, vs }) => {
        const key = matchupKey(my, vs);
        const tint = raceTint(my);
        return (
          <PillButton
            key={key}
            active={value === key}
            onClick={() => onChange(key)}
            tintBg={tint.bg}
            tintBorder={tint.border}
            tintText={tint.text}
          >
            <Icon name={raceIconName(my)} kind="race" size={14} decorative />
            <span className="font-mono">{key}</span>
          </PillButton>
        );
      })}
    </div>
  );
}

interface PillButtonProps {
  active: boolean;
  onClick: () => void;
  tintBg?: string;
  tintBorder?: string;
  tintText?: string;
  children: React.ReactNode;
}

function PillButton({
  active,
  onClick,
  tintBg,
  tintBorder,
  tintText,
  children,
}: PillButtonProps) {
  return (
    <button
      type="button"
      role="radio"
      aria-checked={active}
      onClick={onClick}
      className={[
        "inline-flex min-h-[36px] items-center gap-1.5 whitespace-nowrap rounded-full border px-3 text-caption font-medium",
        "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-2 focus-visible:ring-offset-bg",
        active
          ? [
              "border-accent-cyan/60 bg-accent-cyan/15 text-accent-cyan",
              tintBg ?? "",
              tintBorder ?? "",
              tintText ?? "",
            ].join(" ")
          : "border-border bg-bg-elevated text-text-muted hover:border-border-strong hover:text-text",
      ].join(" ")}
    >
      {children}
    </button>
  );
}
