"use client";

import { useRouter } from "next/navigation";
import { Field } from "@/components/ui/Field";
import { Select } from "@/components/ui/Select";
import {
  LEAGUE_BANDS,
  MATCHUPS,
  REVIEW_TAGS,
  boardQuery,
  type BoardFilters,
} from "@/lib/reviews";

/**
 * Board filters: every change is a navigation to a canonical URL, so each
 * filtered board is a shareable, server-rendered page.
 */
export function ReviewBoardFilters({ filters }: { filters: BoardFilters }) {
  const router = useRouter();
  const go = (next: Partial<BoardFilters>) => {
    router.push(`/reviews${boardQuery({ ...filters, ...next })}`, { scroll: false });
  };
  return (
    <form
      role="search"
      aria-label="Filter review requests"
      className="flex flex-wrap items-end gap-2"
      onSubmit={(e) => e.preventDefault()}
    >
      <div role="group" aria-label="Sort" className="inline-flex rounded-full border-2 border-line p-0.5 text-caption font-semibold">
        {(["hot", "new", "top"] as const).map((sort) => (
          <button
            key={sort}
            type="button"
            aria-pressed={filters.sort === sort}
            onClick={() => go({ sort })}
            className={`min-h-[36px] rounded-full px-3 ${filters.sort === sort ? "bg-accent text-white" : "text-text-muted hover:text-text"}`}
          >
            {sort === "hot" ? "Hot" : sort === "new" ? "New" : "Top"}
          </button>
        ))}
      </div>
      <Field label="Race (asker race)">
        <Select selectSize="sm" value={filters.race ?? ""} onChange={(e) => go({ race: e.target.value as BoardFilters["race"] || null, matchup: !e.target.value || filters.matchup?.startsWith(e.target.value) ? filters.matchup : null })}>
          <option value="">All</option><option value="P">Protoss</option><option value="T">Terran</option><option value="Z">Zerg</option>
        </Select>
      </Field>
      <Field label="Matchup">
        <Select selectSize="sm" value={filters.matchup ?? ""} onChange={(e) => go({ matchup: e.target.value || null })}>
          <option value="">All</option>
          {MATCHUPS.filter((m) => !filters.race || m.startsWith(filters.race)).map((m) => <option key={m} value={m}>{m}</option>)}
        </Select>
      </Field>
      <Field label="League">
        <Select aria-label="League band" selectSize="sm" value={filters.band ?? ""} onChange={(e) => go({ band: e.target.value === "" ? null : Number(e.target.value) })}>
          <option value="">All</option>
          {LEAGUE_BANDS.map((b) => <option key={b.id} value={b.id}>{b.label}</option>)}
        </Select>
      </Field>
      <Field label="Focus">
        <Select aria-label="Focus tag" selectSize="sm" value={filters.tag ?? ""} onChange={(e) => go({ tag: e.target.value || null })}>
          <option value="">Any</option>
          {REVIEW_TAGS.map((t) => <option key={t.key} value={t.key}>{t.label}</option>)}
        </Select>
      </Field>
      <label className="flex min-h-[40px] items-center gap-2 rounded-lg px-1 text-caption font-semibold text-text">
        <input type="checkbox" checked={filters.unanswered} onChange={(e) => go({ unanswered: e.target.checked })} className="h-4 w-4 accent-[rgb(var(--accent))]" />
        Unanswered
      </label>
    </form>
  );
}
