"use client";

import { useEffect, useState, useTransition } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { Search, X } from "lucide-react";
import { Button } from "@/components/ui/Button";
import { Input } from "@/components/ui/Input";
import { Select } from "@/components/ui/Select";
import { Icon } from "@/components/ui/Icon";
import { COMMON_MATCHUPS, raceIconName } from "@/lib/race";
import { COMMUNITY_SORTS, type CommunitySort } from "./types";

export interface CommunityFilterBarProps {
  initialMatchup: string;
  initialSort: CommunitySort;
  initialSearch: string;
}

const MATCHUP_VALUES = COMMON_MATCHUPS.map(
  (m) => `${m.my[0]}v${m.vs[0]}`,
);

/**
 * CommunityFilterBar — controls for the /community grid.
 *
 * Pushes state into the URL so server components re-render with the
 * new query. The search input is debounced (300ms) so each keystroke
 * doesn't trigger a fetch. Mobile (<768) collapses the chips into a
 * scrolling row + uses the native select control to fit on screen.
 */
export function CommunityFilterBar({
  initialMatchup,
  initialSort,
  initialSearch,
}: CommunityFilterBarProps) {
  const router = useRouter();
  const sp = useSearchParams();
  const [search, setSearch] = useState(initialSearch);
  const [, startTransition] = useTransition();

  // Debounce search → URL.
  useEffect(() => {
    if (search === initialSearch) return;
    const handle = window.setTimeout(() => {
      const next = mergeQuery(sp, { q: search });
      startTransition(() => {
        router.replace(`/community${next}`, { scroll: false });
      });
    }, 300);
    return () => window.clearTimeout(handle);
    // initialSearch intentionally excluded so the input isn't reset by a
    // prop change that's already mirrored locally.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [search]);

  function setMatchup(next: string) {
    const merged = mergeQuery(sp, { matchup: next || null });
    startTransition(() => {
      router.replace(`/community${merged}`, { scroll: false });
    });
  }

  function setSort(next: CommunitySort) {
    const merged = mergeQuery(sp, { sort: next === "top" ? null : next });
    startTransition(() => {
      router.replace(`/community${merged}`, { scroll: false });
    });
  }

  return (
    <div className="space-y-3">
      <div className="flex flex-col gap-2 md:flex-row md:items-center md:gap-3">
        <div className="relative flex-1">
          <Search
            className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-text-muted"
            aria-hidden
          />
          <Input
            type="search"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search by title, description, or author"
            aria-label="Search community builds"
            className="pl-9"
          />
          {search ? (
            <button
              type="button"
              aria-label="Clear search"
              onClick={() => setSearch("")}
              className="absolute right-2 top-1/2 inline-flex h-7 w-7 -translate-y-1/2 items-center justify-center rounded-md text-text-muted hover:bg-bg-elevated hover:text-text focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
            >
              <X className="h-4 w-4" aria-hidden />
            </button>
          ) : null}
        </div>
        <label className="flex items-center gap-2 text-caption text-text-muted md:w-auto">
          <span className="sr-only md:not-sr-only">Sort</span>
          <Select
            aria-label="Sort"
            value={initialSort}
            onChange={(e) => setSort(e.target.value as CommunitySort)}
            className="min-w-[160px]"
          >
            {COMMUNITY_SORTS.map((s) => (
              <option key={s.value} value={s.value} title={s.hint}>
                {s.label}
              </option>
            ))}
          </Select>
        </label>
      </div>
      <nav
        aria-label="Filter by matchup"
        className="-mx-1 flex flex-wrap items-center gap-1.5 overflow-x-auto px-1 pb-1 md:flex-wrap"
      >
        <MatchupChip
          active={!initialMatchup}
          onClick={() => setMatchup("")}
          label="All"
        />
        {MATCHUP_VALUES.map((mu, i) => {
          const m = COMMON_MATCHUPS[i];
          return (
            <MatchupChip
              key={mu}
              active={initialMatchup === mu}
              onClick={() => setMatchup(mu)}
              label={mu}
              raceIcon={raceIconName(m.my)}
            />
          );
        })}
      </nav>
    </div>
  );
}

function MatchupChip({
  active,
  onClick,
  label,
  raceIcon,
}: {
  active: boolean;
  onClick: () => void;
  label: string;
  raceIcon?: string;
}) {
  return (
    <Button
      type="button"
      size="sm"
      variant={active ? "primary" : "secondary"}
      onClick={onClick}
      iconLeft={
        raceIcon ? (
          <Icon name={raceIcon} kind="race" size={12} decorative />
        ) : undefined
      }
      aria-pressed={active}
      className="whitespace-nowrap"
    >
      {label}
    </Button>
  );
}

function mergeQuery(
  current: URLSearchParams,
  patch: Record<string, string | null>,
): string {
  const next = new URLSearchParams(current.toString());
  for (const [k, v] of Object.entries(patch)) {
    if (v === null || v === "") next.delete(k);
    else next.set(k, v);
  }
  // Reset pagination when filters change.
  next.delete("offset");
  const qs = next.toString();
  return qs ? `?${qs}` : "";
}
