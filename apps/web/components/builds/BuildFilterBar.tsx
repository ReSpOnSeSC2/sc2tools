"use client";

import { useRef } from "react";
import { usePageSearchShortcut } from "@/lib/usePageSearchShortcut";
import { Search, X } from "lucide-react";
import { Field } from "@/components/ui/Field";
import { Icon } from "@/components/ui/Icon";
import { Input } from "@/components/ui/Input";
import { Select } from "@/components/ui/Select";
import { Toggle } from "@/components/ui/Toggle";
import { FilterPill } from "@/components/ui/FilterPill";
import {
  COMMON_MATCHUPS,
  raceIconName,
  raceLetter,
  type Race,
} from "@/lib/race";
import { activeBuildFilterCount } from "./buildLibraryFilters";

export type BuildSortKey = "updated" | "winRate" | "games" | "name" | "lastPlayed";

export interface BuildFilterState {
  search: string;
  /** "All" or "PvT" / "PvZ" / etc. */
  matchup: string;
  sort: BuildSortKey;
  hideEmpty: boolean;
  /** All builds, your own ("mine") or opponent captures ("opp"). */
  source: "all" | "mine" | "opp";
  /** Only builds published to Community. */
  published: boolean;
  /** The build's own race; a matchup narrows it further. */
  race: "" | "P" | "T" | "Z";
  /** Builds carrying every one of these tags. */
  tags: string[];
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
  /** The library's tags, most used first (from the list response). */
  availableTags?: ReadonlyArray<{ tag: string; count: number }>;
}

const SORT_OPTIONS: ReadonlyArray<{ value: BuildSortKey; label: string }> = [
  { value: "updated", label: "Recently edited" },
  { value: "lastPlayed", label: "Last played" },
  { value: "winRate", label: "Win rate" },
  { value: "games", label: "Most games" },
  { value: "name", label: "Name (A→Z)" },
];

const SOURCES: ReadonlyArray<{ value: BuildFilterState["source"]; label: string }> = [
  { value: "all", label: "All" },
  { value: "mine", label: "Mine" },
  { value: "opp", label: "Opponent captures" },
];

const RACES: ReadonlyArray<{ letter: "P" | "T" | "Z"; race: Race }> = [
  { letter: "P", race: "Protoss" },
  { letter: "T", race: "Terran" },
  { letter: "Z", race: "Zerg" },
];

/**
 * BuildFilterBar — search, sort, Mine / Opponent captures, Published,
 * race pills that open into that race's matchups, tag chips and hide-empty.
 * Stacks vertically on mobile; pill rows wrap.
 */
export function BuildFilterBar({
  value,
  onChange,
  total,
  libraryTotal, onSearchCommit, updating, onClearFilters, availableTags = [],
}: BuildFilterBarProps) {
  const searchRef = useRef<HTMLInputElement>(null);
  usePageSearchShortcut(searchRef);
  const activeCount = activeBuildFilterCount(value);
  function update<K extends keyof BuildFilterState>(
    key: K,
    next: BuildFilterState[K],
  ) {
    onChange({ ...value, [key]: next });
  }
  const toggleTag = (tag: string) => update("tags", value.tags.some((item) => item.toLowerCase() === tag.toLowerCase())
    ? value.tags.filter((item) => item.toLowerCase() !== tag.toLowerCase())
    : [...value.tags, tag].slice(0, 8));

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
      <div className="flex flex-wrap items-center gap-2">
        <div role="radiogroup" aria-label="Whose builds" className="inline-flex flex-wrap rounded-full border-2 border-line p-0.5">
          {SOURCES.map((option) => (
            <button
              key={option.value}
              type="button"
              role="radio"
              aria-checked={value.source === option.value}
              onClick={() => update("source", option.value)}
              className={[
                "min-h-11 rounded-full px-3 text-caption font-semibold",
                "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent",
                value.source === option.value ? "bg-accent text-white" : "text-text-muted hover:text-text",
              ].join(" ")}
            >
              {option.label}
            </button>
          ))}
        </div>
        <FilterPill active={value.published} onClick={() => update("published", !value.published)}>
          Published
        </FilterPill>
      </div>
      <div className="flex flex-wrap items-center justify-between gap-3">
        <RaceMatchupPills
          race={value.race}
          matchup={value.matchup}
          onChange={(race, matchup) => onChange({ ...value, race, matchup })}
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
      {availableTags.length > 0 || value.tags.length > 0 ? (
        <div role="group" aria-label="Filter by tag" className="flex flex-wrap gap-1.5">
          {mergedTags(availableTags, value.tags).map((tag) => (
            <FilterPill
              key={tag.toLowerCase()}
              active={value.tags.some((item) => item.toLowerCase() === tag.toLowerCase())}
              onClick={() => toggleTag(tag)}
            >
              #{tag}
            </FilterPill>
          ))}
        </div>
      ) : null}
      <div className="flex flex-wrap items-center gap-3 text-caption text-text-dim" aria-live="polite">
        <span>{activeCount ? libraryTotal != null ? `${total} of ${libraryTotal} builds match` : `${total} builds match` : `${total} build${total === 1 ? "" : "s"}`}</span>
        {updating ? <span role="status">Updating…</span> : null}
        {activeCount > 0 && onClearFilters ? <button className="min-h-11 px-2 text-accent" onClick={onClearFilters}>Clear filters ({activeCount})</button> : null}
      </div>
    </section>
  );
}

/** The library's tags plus any selected tag the list no longer reports. */
function mergedTags(available: ReadonlyArray<{ tag: string }>, selected: ReadonlyArray<string>): string[] {
  const tags = available.map((item) => item.tag);
  for (const tag of selected) {
    if (!tags.some((item) => item.toLowerCase() === tag.toLowerCase())) tags.push(tag);
  }
  return tags;
}

/**
 * All · P · T · Z; the active race opens into its three matchups. Picking
 * the active race again (or All) clears both.
 */
function RaceMatchupPills({
  race,
  matchup,
  onChange,
}: {
  race: BuildFilterState["race"];
  matchup: string;
  onChange: (race: BuildFilterState["race"], matchup: string) => void;
}) {
  const active = race || (matchup !== "All" ? matchup[0] as BuildFilterState["race"] : "");
  return (
    <div role="group" aria-label="Filter by race and matchup" className="flex flex-wrap gap-1.5">
      <FilterPill active={!active} onClick={() => onChange("", "All")}>All</FilterPill>
      {RACES.map(({ letter, race: raceName }) => (
        <FilterPill
          key={letter}
          active={active === letter && matchup === "All"}
          aria-expanded={active === letter}
          aria-label={`${raceName} builds`}
          onClick={() => onChange(active === letter && matchup === "All" ? "" : letter, "All")}
        >
          <Icon name={raceIconName(raceName)} kind="race" size={14} decorative />
          <span className="font-mono">{letter}</span>
        </FilterPill>
      ))}
      {active
        ? COMMON_MATCHUPS.filter(({ my }) => raceLetter(my) === active).map(({ my, vs }) => {
          const key = `${raceLetter(my)}v${raceLetter(vs)}`;
          return (
            <FilterPill key={key} active={matchup === key} onClick={() => onChange(active, matchup === key ? "All" : key)}>
              <span className="font-mono">{key}</span>
            </FilterPill>
          );
        })
        : null}
    </div>
  );
}
