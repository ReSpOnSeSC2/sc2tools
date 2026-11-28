"use client";

import { useRef, useState, type FormEvent } from "react";
import { ChevronDown, Search } from "lucide-react";
import { Button } from "@/components/ui/Button";
import { Field } from "@/components/ui/Field";
import { Select } from "@/components/ui/Select";
import {
  ANY_FILTERS,
  LENGTH_OPTIONS,
  MATCHUP_OPTIONS,
  RATING_OPTIONS,
  mapOptions,
  sameFilters,
  type LadderFilters,
  type MapChoice,
} from "@/lib/ladder/vods";

type Props = {
  filters: LadderFilters;
  /** The Map menu the server offers. */
  maps: readonly MapChoice[];
  onChange: (next: LadderFilters) => void;
  onSearch: () => void;
};

const GROUP = "grid gap-3 sm:grid-cols-2";
const HEADING = "px-0 text-micro font-semibold uppercase tracking-wide text-text-muted";

/**
 * Four menus in two short groups, one Search button. Enter in a menu searches
 * too. On a phone the second group (length, map) folds away behind "More
 * filters", so the first games are not pushed below the fold.
 */
export function LadderVodFilters({ filters, maps, onChange, onSearch }: Props) {
  const [more, setMore] = useState(false);
  const first = useRef<HTMLSelectElement>(null);
  const extra = [filters.length, filters.map].filter(Boolean).length;
  const menu = (key: keyof LadderFilters, label: string, options: readonly { value: string; label: string }[]) => (
    <Field label={label} htmlFor={`ladder-${key}`}>
      <Select
        ref={key === "matchup" ? first : undefined}
        id={`ladder-${key}`}
        selectSize="lg"
        value={filters[key]}
        onChange={event => onChange({ ...filters, [key]: event.target.value })}
      >
        {options.map(option => <option key={option.value} value={option.value}>{option.label}</option>)}
      </Select>
    </Field>
  );
  const submit = (event: FormEvent) => {
    event.preventDefault();
    onSearch();
  };
  /** The button stays (it only switches off), and focus moves to the first menu rather than the page top. */
  const clear = () => {
    onChange(ANY_FILTERS);
    first.current?.focus();
  };
  return (
    <form onSubmit={submit} className="space-y-4 rounded-xl border border-line bg-bg-surface p-4 sm:p-5">
      <div className="grid gap-4 lg:grid-cols-2 lg:gap-6">
        <fieldset className="min-w-0 space-y-2">
          <legend className={HEADING}>Players</legend>
          <div className={GROUP}>
            {menu("matchup", "Matchup", MATCHUP_OPTIONS)}
            {menu("rating", "Rating", RATING_OPTIONS)}
          </div>
        </fieldset>
        <button
          type="button"
          aria-expanded={more}
          aria-controls="ladder-more-filters"
          onClick={() => setMore(previous => !previous)}
          className="-mt-2 inline-flex min-h-11 items-center gap-1.5 self-start rounded-sm text-body font-semibold text-accent focus-visible:ring-2 focus-visible:ring-accent sm:hidden"
        >
          {more ? "Fewer filters" : extra > 0 ? `More filters (${extra} set)` : "More filters"}
          <ChevronDown aria-hidden className={`size-4 transition-transform motion-reduce:transition-none ${more ? "rotate-180" : ""}`} />
        </button>
        <fieldset id="ladder-more-filters" className={`min-w-0 space-y-2 ${more ? "" : "max-sm:hidden"}`}>
          <legend className={HEADING}>Game</legend>
          <div className={GROUP}>
            {menu("length", "Length", LENGTH_OPTIONS)}
            {menu("map", "Map", mapOptions(maps))}
          </div>
        </fieldset>
      </div>
      <div className="flex items-center gap-2 sm:justify-end">
        <Button variant="ghost" size="lg" disabled={sameFilters(filters, ANY_FILTERS)} onClick={clear}>Clear filters</Button>
        <Button type="submit" size="lg" className="flex-1 sm:flex-none" iconLeft={<Search aria-hidden className="size-4" />}>Search</Button>
      </div>
    </form>
  );
}
