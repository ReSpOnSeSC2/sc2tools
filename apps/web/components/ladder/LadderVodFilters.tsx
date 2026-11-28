"use client";

import type { FormEvent } from "react";
import { Search } from "lucide-react";
import { Button } from "@/components/ui/Button";
import { Field } from "@/components/ui/Field";
import { Select } from "@/components/ui/Select";
import {
  ANY_FILTERS,
  LENGTH_OPTIONS,
  MAP_OPTIONS,
  MATCHUP_OPTIONS,
  RATING_OPTIONS,
  sameFilters,
  type LadderFilters,
} from "@/lib/ladder/vods";

type Props = {
  filters: LadderFilters;
  onChange: (next: LadderFilters) => void;
  onSearch: () => void;
  /** The loading skeleton and the gate-off page draw the same form, switched off, so nothing moves. */
  disabled?: boolean;
};

const GROUP = "grid gap-3 sm:grid-cols-2";
const HEADING = "px-0 text-micro font-semibold uppercase tracking-wide text-text-muted";

/** Four menus in two short groups, one Search button. Enter in a menu searches too. */
export function LadderVodFilters({ filters, onChange, onSearch, disabled = false }: Props) {
  const menu = (key: keyof LadderFilters, label: string, options: readonly { value: string; label: string }[]) => (
    <Field label={label} htmlFor={`ladder-${key}`}>
      <Select
        id={`ladder-${key}`}
        selectSize="lg"
        disabled={disabled}
        value={filters[key]}
        onChange={event => onChange({ ...filters, [key]: event.target.value })}
      >
        {options.map(option => <option key={option.value} value={option.value}>{option.label}</option>)}
      </Select>
    </Field>
  );
  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (!disabled) onSearch();
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
        <fieldset className="min-w-0 space-y-2">
          <legend className={HEADING}>Game</legend>
          <div className={GROUP}>
            {menu("length", "Length", LENGTH_OPTIONS)}
            {menu("map", "Map", MAP_OPTIONS)}
          </div>
        </fieldset>
      </div>
      <div className="flex flex-col-reverse gap-2 sm:flex-row sm:items-center sm:justify-end">
        {!sameFilters(filters, ANY_FILTERS) && (
          <Button variant="ghost" size="lg" disabled={disabled} onClick={() => onChange(ANY_FILTERS)}>Clear filters</Button>
        )}
        <Button type="submit" size="lg" disabled={disabled} iconLeft={<Search aria-hidden className="size-4" />}>Search</Button>
      </div>
    </form>
  );
}
