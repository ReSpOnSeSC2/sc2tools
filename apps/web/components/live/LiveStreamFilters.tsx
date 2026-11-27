"use client";

import { SegmentedControl } from "@/components/ui/SegmentedControl";
import { Select } from "@/components/ui/Select";
import {
  languageName,
  PLATFORM_NAMES,
  type LiveFilters,
  type LiveSort,
  type LiveStream,
  type PlatformFilter,
} from "@/lib/live/streams";

const PLATFORM_OPTIONS = [
  { value: "all", label: "All", ariaLabel: "All platforms" },
  { value: "twitch", label: PLATFORM_NAMES.twitch },
  { value: "kick", label: PLATFORM_NAMES.kick },
] as const;
const SORT_OPTIONS = [
  { value: "viewers", label: "Most viewers" },
  { value: "small", label: "Small channels first" },
] as const;

type Props = {
  filters: LiveFilters;
  /** Language codes in the whole list, most streams first. */
  languages: readonly string[];
  streams: readonly LiveStream[];
  onChange: (next: LiveFilters) => void;
};

export function LiveStreamFilters({ filters, languages, streams, onChange }: Props) {
  const countIn = (code: string) => streams.filter(stream => stream.language === code).length;
  return (
    <div className="grid gap-4 rounded-xl border border-line bg-bg-surface p-4 sm:grid-cols-2 lg:grid-cols-3">
      <div>
        <p id="live-platform-label" className="mb-1 text-caption font-semibold text-text">Platform</p>
        <SegmentedControl<PlatformFilter>
          labelledBy="live-platform-label"
          value={filters.platform}
          options={PLATFORM_OPTIONS}
          onChange={platform => onChange({ ...filters, platform })}
        />
      </div>
      <div>
        <label htmlFor="live-language" className="mb-1 block text-caption font-semibold text-text">Language</label>
        <Select
          id="live-language"
          selectSize="lg"
          value={filters.language}
          onChange={event => onChange({ ...filters, language: event.target.value })}
        >
          <option value="all">All languages</option>
          {languages.map(code => (
            <option key={code} value={code}>{languageName(code)} ({countIn(code)})</option>
          ))}
        </Select>
      </div>
      <div className="sm:col-span-2 lg:col-span-1">
        <p id="live-sort-label" className="mb-1 text-caption font-semibold text-text">Order</p>
        <SegmentedControl<LiveSort>
          labelledBy="live-sort-label"
          value={filters.sort}
          options={SORT_OPTIONS}
          onChange={sort => onChange({ ...filters, sort })}
        />
      </div>
    </div>
  );
}
