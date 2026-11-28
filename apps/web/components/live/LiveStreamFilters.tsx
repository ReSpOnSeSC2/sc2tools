"use client";

import { Select } from "@/components/ui/Select";
import {
  languageName,
  PLATFORM_NAMES,
  type LiveFilters,
  type LiveSort,
  type LiveStream,
  type PlatformFilter,
} from "@/lib/live/streams";

type Props = {
  filters: LiveFilters;
  /** Language codes in the whole list, most streams first. */
  languages: readonly string[];
  streams: readonly LiveStream[];
  onChange: (next: LiveFilters) => void;
  /** The loading skeleton draws these same controls, switched off, so nothing moves when the list arrives. */
  disabled?: boolean;
};

/** Three menus of one height: two share the first row on a phone, all three share one row from 640 px. */
export function LiveStreamFilters({ filters, languages, streams, onChange, disabled = false }: Props) {
  const countIn = (code: string) => streams.filter(stream => stream.language === code).length;
  return (
    <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 sm:gap-3">
      <Select
        aria-label="Platform"
        selectSize="lg"
        disabled={disabled}
        value={filters.platform}
        onChange={event => onChange({ ...filters, platform: event.target.value as PlatformFilter })}
      >
        <option value="all">All platforms</option>
        <option value="twitch">{PLATFORM_NAMES.twitch}</option>
        <option value="kick">{PLATFORM_NAMES.kick}</option>
      </Select>
      <Select
        aria-label="Language"
        selectSize="lg"
        disabled={disabled}
        value={filters.language}
        onChange={event => onChange({ ...filters, language: event.target.value })}
      >
        <option value="all">All languages</option>
        {languages.map(code => (
          <option key={code} value={code}>{languageName(code)} ({countIn(code)})</option>
        ))}
      </Select>
      <div className="col-span-2 sm:col-span-1">
        <Select
          aria-label="Order"
          selectSize="lg"
          disabled={disabled}
          value={filters.sort}
          onChange={event => onChange({ ...filters, sort: event.target.value as LiveSort })}
        >
          <option value="viewers">Most viewers first</option>
          <option value="small">Small channels first</option>
        </Select>
      </div>
    </div>
  );
}
